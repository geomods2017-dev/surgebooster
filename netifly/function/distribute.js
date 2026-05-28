const solanaWeb3 = require('@solana/web3.js');
const bs58       = require('bs58');

// ── Config from Netlify environment variables ──
const PRIVATE_KEY    = process.env.WALLET_PRIVATE_KEY;   // base58 private key of your hot wallet
const HELIUS_KEY     = process.env.HELIUS_KEY;
const TOKEN_CONTRACT = process.env.TOKEN_CONTRACT;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET;       // random string you set in Netlify + frontend

const TOKEN_DECIMALS = 6;
const MIN_TOKENS     = 100_000;
const BASE_MAX_SOL   = 0.0001;
const RPC            = 'https://api.mainnet-beta.solana.com';

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: 'Method not allowed' };

  // Verify trigger secret
  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: 'Bad JSON' }; }
  if (body.secret !== TRIGGER_SECRET) return { statusCode: 401, headers, body: 'Unauthorized' };

  if (!PRIVATE_KEY || !HELIUS_KEY || !TOKEN_CONTRACT) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  try {
    const keypair = solanaWeb3.Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    const conn    = new solanaWeb3.Connection(RPC, 'confirmed');

    // ── 1. Fetch qualifying holders ──
    const minRaw  = MIN_TOKENS * Math.pow(10, TOKEN_DECIMALS);
    let holders   = [], page = 1;

    while (true) {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'h' + page,
          method:  'getTokenAccounts',
          params:  { mint: TOKEN_CONTRACT, limit: 1000, page }
        })
      });
      const d     = await r.json();
      const accts = d.result?.token_accounts || [];
      if (!accts.length) break;
      holders.push(...accts.filter(a => parseFloat(a.amount) >= minRaw).map(a => a.owner));
      if (accts.length < 1000) break;
      page++;
    }
    holders = [...new Set(holders)];
    if (holders.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, holders: 0, reason: 'No qualifying holders' }) };
    }

    // ── 2. Calculate reward ──
    const balLamports = await conn.getBalance(keypair.publicKey);
    const balSOL      = balLamports / solanaWeb3.LAMPORTS_PER_SOL;
    const scaledMax   = BASE_MAX_SOL * (1 + balSOL * 0.05);
    const poolCap     = (balSOL * 0.1) / holders.length;
    const maxReward   = Math.min(scaledMax, poolCap);
    const reward      = Math.random() * maxReward;
    const lamports    = Math.floor(reward * solanaWeb3.LAMPORTS_PER_SOL);

    if (lamports < 1) {
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, holders: holders.length, reason: 'Wallet balance too low' }) };
    }

    // ── 3. Batch send (15 transfers per transaction) ──
    const BATCH_SIZE = 15;
    let sent = 0, errors = 0;

    for (let i = 0; i < holders.length; i += BATCH_SIZE) {
      const batch = holders.slice(i, i + BATCH_SIZE);
      const tx    = new solanaWeb3.Transaction();

      for (const addr of batch) {
        tx.add(solanaWeb3.SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey:   new solanaWeb3.PublicKey(addr),
          lamports
        }));
      }

      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash  = blockhash;
      tx.feePayer         = keypair.publicKey;
      tx.sign(keypair);

      try {
        const sig = await conn.sendRawTransaction(tx.serialize());
        await conn.confirmTransaction(sig, 'confirmed');
        sent += batch.length;
      } catch (e) {
        errors++;
        console.error('Batch failed:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:    true,
        sent,
        errors,
        holders:    holders.length,
        rewardSOL:  reward.toFixed(9),
        totalSOL:   (reward * sent).toFixed(6),
        ath:        body.ath,
        wallet:     keypair.publicKey.toString(),
      })
    };

  } catch (e) {
    console.error('Distribution error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
