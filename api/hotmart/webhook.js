// ============================================================================
// WEBHOOK HOTMART -> AssistenteOn
// Recebe a notificação de compra da Hotmart, cria (ou desativa) o acesso do
// cliente no Firebase (Auth + Firestore) e envia um e-mail com login e senha.
//
// Baseado no mesmo modelo do CashOn. Roda como função serverless no Vercel.
// ============================================================================

const admin = require('firebase-admin');
const { Resend } = require('resend');

// ---------------------------------------------------------------------------
// Inicialização do Firebase Admin (uma vez só, reaproveitado entre chamadas)
// A chave de serviço vem da variável de ambiente FIREBASE_SERVICE_ACCOUNT
// (JSON completo, colado como string no Vercel).
// ---------------------------------------------------------------------------
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (e) {
    console.error('Erro ao inicializar Firebase Admin:', e.message);
  }
}

const resend = new Resend(process.env.RESEND_API_KEY);

// ---------------------------------------------------------------------------
// Gera uma senha aleatória amigável. Ex: AO7f3k9m21
// ---------------------------------------------------------------------------
function gerarSenha() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // sem caracteres confusos (l,1,o,0)
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  const num = Math.floor(10 + Math.random() * 90); // 2 dígitos
  return 'AO' + s + num;
}

// ---------------------------------------------------------------------------
// Handler principal do webhook
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  // A Hotmart envia POST. Qualquer outro método é rejeitado.
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // (Opcional, recomendado) valida o token do webhook, se você configurar um
  // segredo (HOTTOK) na Hotmart e na variável de ambiente HOTMART_HOTTOK.
  const hottok = req.headers['x-hotmart-hottok'] || (req.body && req.body.hottok);
  if (process.env.HOTMART_HOTTOK && hottok !== process.env.HOTMART_HOTTOK) {
    console.warn('HOTTOK inválido — requisição ignorada.');
    return res.status(401).json({ error: 'Token inválido' });
  }

  try {
    const body = req.body || {};
    // A Hotmart tem formatos diferentes conforme a versão do webhook.
    // Tentamos cobrir os campos mais comuns (v2 usa body.data.*).
    const evento = body.event || body.status || '';
    const data = body.data || body;

    // extrai e-mail e nome do comprador (cobrindo variações de formato)
    const buyer = data.buyer || data.subscriber || {};
    const email = (buyer.email || data.email || '').toLowerCase().trim();
    const nome = buyer.name || data.name || (email ? email.split('@')[0] : 'Cliente');

    if (!email) {
      console.error('Webhook sem e-mail do comprador. Body:', JSON.stringify(body).slice(0, 500));
      return res.status(400).json({ error: 'E-mail do comprador não encontrado' });
    }

    // -----------------------------------------------------------------------
    // Classifica o evento: ATIVA (compra) ou DESATIVA (cancelamento/reembolso)
    // -----------------------------------------------------------------------
    const eventosAtiva = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE', 'APPROVED', 'COMPLETE'];
    const eventosDesativa = ['SUBSCRIPTION_CANCELLATION', 'PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'CANCELLED', 'REFUNDED', 'CHARGEBACK'];

    const eventoUpper = (evento || '').toString().toUpperCase();

    if (eventosDesativa.some(e => eventoUpper.includes(e))) {
      // ----- DESATIVAÇÃO -----
      await desativarAcesso(email);
      console.log('Acesso desativado:', email);
      return res.status(200).json({ ok: true, acao: 'desativado', email });
    }

    if (eventosAtiva.some(e => eventoUpper.includes(e))) {
      // ----- ATIVAÇÃO / CRIAÇÃO -----
      const resultado = await ativarOuCriarAcesso(email, nome);
      console.log('Acesso ativado/criado:', email, resultado.novo ? '(novo)' : '(reativado)');
      return res.status(200).json({ ok: true, acao: resultado.novo ? 'criado' : 'reativado', email });
    }

    // evento não tratado — responde 200 para a Hotmart não ficar reenviando
    console.log('Evento não tratado:', evento);
    return res.status(200).json({ ok: true, acao: 'ignorado', evento });

  } catch (e) {
    console.error('Erro no webhook:', e);
    return res.status(500).json({ error: 'Erro interno', detalhe: e.message });
  }
};

// ---------------------------------------------------------------------------
// Cria um novo acesso (ou reativa um existente) e envia e-mail se for novo.
// ---------------------------------------------------------------------------
async function ativarOuCriarAcesso(email, nome) {
  const auth = admin.auth();
  const db = admin.firestore();

  let userRecord;
  let senhaGerada = null;
  let novo = false;

  try {
    // já existe? então é reativação (não reenvia senha)
    userRecord = await auth.getUserByEmail(email);
  } catch (e) {
    // não existe -> cria com senha nova
    senhaGerada = gerarSenha();
    userRecord = await auth.createUser({
      email,
      password: senhaGerada,
      displayName: nome,
    });
    novo = true;
  }

  const uid = userRecord.uid;

  // grava/atualiza o perfil no Firestore (users/<uid>)
  await db.collection('users').doc(uid).set({
    nome,
    email,
    role: 'cliente',
    ativo: true,
    origem: 'hotmart',
    atualizadoEm: new Date().toISOString(),
  }, { merge: true });

  // se for novo, envia e-mail com as credenciais
  if (novo && senhaGerada) {
    await enviarEmailBoasVindas(email, nome, senhaGerada);
  }

  return { uid, novo };
}

// ---------------------------------------------------------------------------
// Desativa o acesso (não apaga — só marca ativo:false).
// ---------------------------------------------------------------------------
async function desativarAcesso(email) {
  const auth = admin.auth();
  const db = admin.firestore();
  try {
    const userRecord = await auth.getUserByEmail(email);
    await db.collection('users').doc(userRecord.uid).set({ ativo: false, atualizadoEm: new Date().toISOString() }, { merge: true });
    // opcional: desabilitar no Auth também (impede login imediatamente)
    await auth.updateUser(userRecord.uid, { disabled: true });
  } catch (e) {
    console.warn('Não foi possível desativar (usuário não encontrado?):', email, e.message);
  }
}

// ---------------------------------------------------------------------------
// Envia o e-mail de boas-vindas com login e senha (via Resend).
// ---------------------------------------------------------------------------
async function enviarEmailBoasVindas(email, nome, senha) {
  const APP_URL = 'https://assistenteon.vercel.app';
  const REMETENTE = process.env.EMAIL_REMETENTE || 'AssistenteOn <onboarding@resend.dev>';

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1c23">
    <div style="background:#1a1c23;padding:24px;text-align:center;border-radius:12px 12px 0 0">
      <h1 style="color:#fff;margin:0;font-size:22px">AssistenteOn</h1>
      <p style="color:#8a90a2;margin:6px 0 0;font-size:13px">Seu escritório na palma da mão</p>
    </div>
    <div style="border:1px solid #e5e5e5;border-top:0;padding:28px;border-radius:0 0 12px 12px">
      <p>Olá, <b>${nome}</b>! 🎉</p>
      <p>Seu acesso ao <b>AssistenteOn</b> está pronto. Use os dados abaixo para entrar:</p>
      <div style="background:#f5f7fa;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin:18px 0">
        <p style="margin:0 0 8px"><b>E-mail:</b> ${email}</p>
        <p style="margin:0"><b>Senha:</b> ${senha}</p>
      </div>
      <div style="text-align:center;margin:24px 0">
        <a href="${APP_URL}" style="background:#4f9d8f;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:bold;display:inline-block">Acessar o AssistenteOn</a>
      </div>
      <p style="font-size:13px;color:#666">Recomendamos trocar sua senha após o primeiro acesso (use a opção "Esqueci minha senha" na tela de login para definir uma nova).</p>
      <p style="font-size:12px;color:#999;margin-top:24px;border-top:1px solid #eee;padding-top:16px">
        Você recebeu este e-mail porque adquiriu o AssistenteOn. Em caso de dúvida, responda este e-mail.
      </p>
    </div>
  </div>`;

  await resend.emails.send({
    from: REMETENTE,
    to: email,
    subject: '🎉 Seu acesso ao AssistenteOn está pronto!',
    html,
  });
}
