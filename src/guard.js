// Read-only enforcement. Every command ioredis sends goes through sendCommand,
// so patching it here means a bug elsewhere in rivulet can never write to,
// ack on, or claim from the Redis it is observing.

const ANY = null;

export const ALLOWED = new Map([
  ['xinfo', new Set(['stream', 'groups', 'consumers'])],
  ['xread', ANY],
  ['xrange', ANY],
  ['xrevrange', ANY],
  ['xpending', ANY],
  // discovery + clock + version
  ['scan', ANY],
  ['type', ANY],
  ['time', ANY],
  ['info', ANY],
  // connection housekeeping ioredis may send on its own
  ['ping', ANY],
  ['auth', ANY],
  ['select', ANY],
  ['quit', ANY],
]);

const str = (v) => (Buffer.isBuffer(v) ? v.toString() : String(v)).toLowerCase();

export function isAllowed(name, args = []) {
  const cmd = str(name);
  if (!ALLOWED.has(cmd)) return false;
  const subs = ALLOWED.get(cmd);
  if (subs === ANY) return true;
  return args.length > 0 && subs.has(str(args[0]));
}

export class BlockedCommandError extends Error {
  constructor(name, args) {
    const sub = args?.length && str(name) === 'xinfo' ? ` ${str(args[0]).toUpperCase()}` : '';
    super(`rivulet is read-only: blocked ${str(name).toUpperCase()}${sub}`);
    this.name = 'BlockedCommandError';
  }
}

export function guard(redis) {
  const send = redis.sendCommand.bind(redis);
  redis.sendCommand = (command, stream) => {
    if (!isAllowed(command.name, command.args)) {
      command.reject(new BlockedCommandError(command.name, command.args));
      return command.promise;
    }
    return send(command, stream);
  };
  return redis;
}
