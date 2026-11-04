'use strict';

const os = require('os');
const path = require('path');

const {
  RATE,
  createScratch,
  permute,
  absorbBlock,
  hashMessage
} = require('./keccak');

const WORKER_PATH = path.join(__dirname, 'pow-worker.js');

function normalizeChallenge(challenge) {
  if (!challenge || typeof challenge !== 'object') {
    throw new Error('challenge must be an object');
  }
  const salt = challenge.salt;
  const expireAt = challenge.expire_at !== undefined ? challenge.expire_at : challenge.expireAt;
  const target = challenge.challenge;
  const difficulty = Number(challenge.difficulty);

  if (typeof salt !== 'string') throw new Error('challenge.salt is missing');
  if (expireAt === undefined || expireAt === null) throw new Error('challenge.expire_at is missing');
  if (typeof target !== 'string' || !/^[0-9a-fA-F]{64}$/.test(target)) {
    throw new Error('challenge.challenge must be a 64-char hex string');
  }
  if (!Number.isFinite(difficulty) || difficulty < 0) {
    throw new Error('challenge.difficulty must be a non-negative number');
  }
  return { salt, expireAt, target, difficulty, algorithm: challenge.algorithm || 'DeepSeekHashV1' };
}

function buildPrefix(salt, expireAt) {
  return `${salt}_${expireAt}_`;
}

/**
 * Synchronous brute-force over [start, end).
 * Returns the matching nonce, or -1.
 */
function solveRangeSync(params) {
  const {
    base,
    targetHex,
    start = 0,
    end,
    onProgress
  } = params;

  if (typeof base !== 'string') throw new Error('base is required');
  if (typeof targetHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(targetHex)) {
    throw new Error('targetHex must be a 64-char hex string');
  }

  const baseBuf = Buffer.from(base, 'utf8');
  if (baseBuf.length > RATE - 20) {
    throw new Error('PoW prefix is too long');
  }

  const target = Buffer.from(targetHex, 'hex');
  const tLo = new Uint32Array(4);
  const tHi = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    tLo[i] = target.readUInt32LE(i * 8);
    tHi[i] = target.readUInt32LE(i * 8 + 4);
  }

  const limit = end === undefined ? Number.MAX_SAFE_INTEGER : end;
  if (limit <= start) return -1;

  const block = Buffer.alloc(RATE);
  baseBuf.copy(block, 0);
  const baseLen = baseBuf.length;
  const stateLo = new Uint32Array(25);
  const stateHi = new Uint32Array(25);
  const scratch = createScratch();

  let lastReport = Date.now();

  for (let nonce = start; nonce < limit; nonce++) {
    // Rebuild the message: prefix + decimal nonce, SHA3 padding.
    block.fill(0, baseLen);
    const digits = String(nonce);
    block.write(digits, baseLen, 'ascii');
    const padPos = baseLen + digits.length;
    block[padPos] = 0x06;
    if (padPos === RATE - 1) {
      block[RATE - 1] ^= 0x80;
    } else {
      block[RATE - 1] = 0x80;
    }

    stateLo.fill(0);
    stateHi.fill(0);
    absorbBlock(block, stateLo, stateHi);
    permute(stateLo, stateHi, 23, scratch);

    if (
      stateLo[0] === tLo[0] && stateHi[0] === tHi[0] &&
      stateLo[1] === tLo[1] && stateHi[1] === tHi[1] &&
      stateLo[2] === tLo[2] && stateHi[2] === tHi[2] &&
      stateLo[3] === tLo[3] && stateHi[3] === tHi[3]
    ) {
      return nonce;
    }

    if (onProgress && (nonce & 0x3fff) === 0) {
      const now = Date.now();
      if (now - lastReport >= 250) {
        lastReport = now;
        onProgress(nonce - start, limit - start);
      }
    }
  }

  return -1;
}

function verifyAnswer(params) {
  const { salt, expireAt, challenge, answer } = params;
  const base = buildPrefix(salt, expireAt);
  const digest = hashMessage(Buffer.from(base + String(answer), 'utf8'), { rounds: 23 });
  return digest.toString('hex').toLowerCase() === String(challenge).toLowerCase();
}

function defaultThreads(difficulty) {
  const cpus = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, Math.min(cpus, 8, Math.max(1, Math.floor(difficulty / 2000))));
}

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const { Worker } = require('worker_threads');
    const worker = new Worker(WORKER_PATH, { workerData: payload });
    let settled = false;

    worker.once('message', (msg) => {
      if (settled) return;
      settled = true;
      resolve({ worker, msg });
    });
    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ worker, msg: null });
      else reject(new Error(`PoW worker exited with code ${code}`));
    });
  });
}

/**
 * Solve a DeepSeek PoW challenge.
 *
 * @param {object} challenge challenge object from create_pow_challenge
 * @param {{threads?: number, onProgress?: Function}} [opts]
 * @returns {Promise<{answer:number, elapsedMs:number, threads:number, attempts:number}>}
 */
async function solveChallenge(challenge, opts) {
  const options = opts || {};
  const { salt, expireAt, target, difficulty, algorithm } = normalizeChallenge(challenge);

  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unsupported PoW algorithm: ${algorithm}`);
  }

  const base = buildPrefix(salt, expireAt);
  const total = Math.floor(difficulty) + 1; // inclusive upper bound
  const threads = Math.max(1, Math.min(
    options.threads === undefined ? defaultThreads(total) : Number(options.threads) || 1,
    total
  ));

  const startedAt = Date.now();
  let answer = -1;

  if (threads === 1) {
    answer = solveRangeSync({
      base,
      targetHex: target,
      start: 0,
      end: total,
      onProgress: options.onProgress
    });
  } else {
    const chunk = Math.ceil(total / threads);
    const jobs = [];
    for (let i = 0; i < threads; i++) {
      const start = i * chunk;
      const end = Math.min(start + chunk, total);
      if (start >= end) continue;
      jobs.push(runWorker({ base, targetHex: target, start, end }));
    }

    // First worker to find a nonce wins; the rest are terminated.
    answer = await new Promise((resolve, reject) => {
      let pending = jobs.length;
      let done = false;
      for (const job of jobs) {
        job.then(({ worker, msg }) => {
          if (done) {
            worker.terminate();
            return;
          }
          if (msg && msg.answer >= 0) {
            done = true;
            resolve(msg.answer);
            for (const other of jobs) {
              other.then(({ worker: w }) => { if (w !== worker) w.terminate(); }).catch(() => {});
            }
            return;
          }
          pending--;
          if (pending === 0 && !done) {
            done = true;
            resolve(-1);
          }
        }).catch((err) => {
          if (done) return;
          done = true;
          reject(err);
        });
      }
    });
  }

  const elapsedMs = Date.now() - startedAt;
  if (answer < 0) {
    throw new Error(`PoW not solved within difficulty ${difficulty}`);
  }

  return {
    answer,
    elapsedMs,
    threads,
    attempts: answer + 1,
    difficulty,
    prefix: base,
    verified: verifyAnswer({ salt, expireAt, challenge: target, answer })
  };
}

function buildPowHeader(challenge, answer) {
  const payload = {
    algorithm: challenge.algorithm || 'DeepSeekHashV1',
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path || challenge.targetPath || '/api/v0/chat/completion'
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

module.exports = {
  normalizeChallenge,
  buildPrefix,
  solveRangeSync,
  solveChallenge,
  verifyAnswer,
  buildPowHeader,
  defaultThreads
};
