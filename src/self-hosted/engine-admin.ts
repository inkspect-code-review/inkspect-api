import { database, closeDatabases } from "../database";

const [action, generation, origin] = process.argv.slice(2);
try {
  if (action === 'activate') {
    if (!generation || !/^[\w.-]{1,100}$/.test(generation) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Usage: activate GENERATION http://127.0.0.1:PORT');
    const port = Number(new URL(origin).port);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid engine port');
    await database().query('UPDATE api_engine_runtime SET generation=$1,origin=$2 WHERE id', [generation, origin]);
  } else if (action === 'status') {
    console.log(JSON.stringify((await database().query('SELECT generation,origin FROM api_engine_runtime WHERE id')).rows[0]));
  } else throw new Error('Use activate or status.');
} finally { await closeDatabases(); }
