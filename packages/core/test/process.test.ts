/**
 * These tests exist because of a real bug, twice.
 *
 * Arguments containing spaces or quotes were being re-parsed by cmd.exe and
 * arriving at the child process mangled — first as a prompt the model appeared
 * to ignore, then as `git commit -m "fix: thing"` failing with a pathspec error.
 * Both had the same cause and neither looked like a quoting problem.
 */
import { describe, expect, it } from 'vitest';

import { commandExists, runCommand, startProcess } from '../src/process.js';

const echoArgs = '-e';
const printArgv = 'console.log(JSON.stringify(process.argv.slice(1)))';

describe('runCommand', () => {
  it('passes arguments through verbatim, spaces and colons included', async () => {
    const args = ['a b c', 'fix: something broke', 'quote"inside', '100% done'];

    const result = await runCommand(process.execPath, [echoArgs, printArgv, ...args], { cwd: process.cwd() });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it('returns a non-zero exit as data, not as a throw', async () => {
    const result = await runCommand(process.execPath, [echoArgs, 'process.exit(3)'], { cwd: process.cwd() });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('kills a hung process and says so', async () => {
    const result = await runCommand(process.execPath, [echoArgs, 'setTimeout(()=>{},60000)'], {
      cwd: process.cwd(),
      timeoutMs: 800,
    });

    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('treats a missing executable as an ordinary failure', async () => {
    const result = await runCommand('definitely-not-a-real-binary-xyz', [], { cwd: process.cwd() });

    expect(result.ok).toBe(false);
    expect(result.stderr).not.toBe('');
  });

  it('closes stdin so a child waiting for input cannot hang the loop', async () => {
    const script = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log("got:"+d))';

    const result = await runCommand(process.execPath, [echoArgs, script], { cwd: process.cwd(), timeoutMs: 5000 });

    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe('got:');
  });
});

/**
 * `startProcess` exists for detectors that have to boot the thing they measure —
 * an API server, in phase 2. The risk it carries is a leaked process holding a
 * port, which fails the *next* run for a reason that has nothing to do with it.
 */
describe('startProcess', () => {
  it('returns while the process is still running', async () => {
    const handle = await startProcess(process.execPath, [echoArgs, 'setTimeout(() => {}, 60000)'], {
      cwd: process.cwd(),
    });

    expect(handle.pid).toBeGreaterThan(0);
    await handle.stop();
    await expect(handle.exited).resolves.not.toBeUndefined();
  });

  it('is safe to stop twice', async () => {
    const handle = await startProcess(process.execPath, [echoArgs, 'setTimeout(() => {}, 60000)'], {
      cwd: process.cwd(),
    });

    // Called from a `finally` on the happy path and from an abort handler on the
    // unhappy one — sometimes both, for the same process.
    await Promise.all([handle.stop(), handle.stop()]);
    await handle.stop();
  });

  it('keeps the output of a process that dies on startup', async () => {
    const handle = await startProcess(process.execPath, [echoArgs, 'console.error("port already in use")'], {
      cwd: process.cwd(),
    });

    await handle.exited;
    // The only thing that distinguishes a port clash from a fixer having just
    // broken the file it edited.
    expect(handle.output()).toContain('port already in use');
    await handle.stop();
  });
});

describe('commandExists', () => {
  it('finds a real executable on PATH', async () => {
    // git is a hard requirement of this project, so it is a fair thing to assert.
    expect(await commandExists('git')).toBe(true);
  });

  it('reports a missing one without spawning anything', async () => {
    expect(await commandExists('definitely-not-a-real-binary-xyz')).toBe(false);
  });
});
