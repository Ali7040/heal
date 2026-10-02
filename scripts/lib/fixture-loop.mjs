/**
 * Setting a fixture up to be healed — shared by the demo and the benchmark.
 *
 * Shared on purpose: a benchmark that set fixtures up differently from the demo
 * would measure a loop nobody watches, and the two would drift apart silently.
 *
 * Detector selection is data-driven — the fixture's shape decides, not a flag. A
 * fixture with a `check` command is measured by exit code, one with a `serve`
 * block by asking its API, and the chart fixture by its pixels.
 */
import { GitRepo } from '@self-heal/core/git/repo';
import { silentLogger } from '@self-heal/core/logger';
import { CommandDetector } from '@self-heal/detector-command';
import { ContractDetector } from '@self-heal/detector-contract';
import { VisualDetector } from '@self-heal/detector-visual';
import { Sandbox } from '@self-heal/testkit/sandbox';
import { snapshotDir } from '@self-heal/testkit/snapshot';
import { freePort } from '@self-heal/testkit/server';
import { CHART_FIXED_SOURCE } from '@self-heal/testkit/fixtures';

/** Returns `{ detector, describeMeasurement }`, with the sandbox left broken and committed. */
export async function prepareDetector(fixture, sandbox) {
  if (fixture.serve !== undefined && fixture.id === 'chart-colour-collision') {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const server = {
      command: process.execPath,
      args: [fixture.serve.entry],
      readyUrl: `${base}${fixture.serve.readyPath}`,
      env: { PORT: String(port) },
    };

    // A visual baseline has to be recorded from a picture someone approved, so the
    // sandbox starts healthy, records, and only then does the regression land.
    // That is the real workflow, not a shortcut for the demo.
    const detector = new VisualDetector({
      id: 'chart-ui',
      views: fixture.serve.endpoints.map((endpoint) => ({
        name: endpoint.name,
        url: `${base}${endpoint.path}`,
        editable: [...fixture.editable],
      })),
      server,
    });

    await sandbox.write(fixture.primary, CHART_FIXED_SOURCE);
    await detector.detect(contextFor(sandbox));
    await sandbox.write(fixture.primary, fixture.files[fixture.primary]);
    await new GitRepo({ dir: sandbox.dir }).checkpoint('demo: the regression lands');

    return { detector, describeMeasurement: 'measuring: rendered pixels vs an approved baseline' };
  }

  if (fixture.serve !== undefined) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    return {
      detector: new ContractDetector({
        id: 'orders-api',
        endpoints: fixture.serve.endpoints.map((endpoint) => ({
          name: endpoint.name,
          url: `${base}${endpoint.path}`,
          editable: [...fixture.editable],
        })),
        // Booted fresh for detect and again for verify, so a fix on disk is
        // actually the thing being measured the second time.
        server: {
          command: process.execPath,
          args: [fixture.serve.entry],
          readyUrl: `${base}${fixture.serve.readyPath}`,
          env: { PORT: String(port) },
        },
      }),
      describeMeasurement: 'measuring: live HTTP response vs recorded contract',
    };
  }

  return {
    detector: new CommandDetector({
      id: 'fixture-check',
      command: fixture.check.command,
      args: [...fixture.check.args],
      editable: [...fixture.editable],
      kind: 'check-failed',
    }),
    describeMeasurement: 'measuring: exit code of the fixture check',
  };
}

/**
 * The harness never touches the fixture repository: it gets a snapshot copied
 * into a second disposable sandbox, destroyed when the proposal is done.
 */
export function workspaceFrom(sandbox) {
  return async () => {
    const files = await snapshotDir(sandbox.dir);
    const workspace = await Sandbox.create({ files, prefix: 'self-heal-work-' });
    return { dir: workspace.dir, dispose: () => workspace.dispose() };
  };
}

export function contextFor(sandbox, dryRun = false) {
  return {
    repoRoot: sandbox.dir,
    evidenceDir: `${sandbox.dir}/.self-heal/evidence`,
    dryRun,
    config: {},
    log: silentLogger,
  };
}
