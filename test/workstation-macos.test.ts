/**
 * The scripts of workstation/macos in a dry run. A dry run prints each
 * privileged command and each file it would write, so these tests run on
 * Linux. The stubs of dscl, dseditgroup, systemsetup, and launchctl stand in
 * for a Mac: they read a fake directory in a temporary folder. The tests
 * check what the scripts plan. They cannot check what macOS does.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkstation } from '../src/host/workstation.ts';

const MACOS = fileURLToPath(new URL('../workstation/macos/', import.meta.url));
const ACCOUNTS = readFileSync(new URL('../workstation/accounts', import.meta.url), 'utf8')
	.split('\n')
	.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
const GIT = 'workbench-git';
const EVERY = [...ACCOUNTS, GIT];
const MARK = 'workbench-macos';

function available(command: string): boolean {
	return spawnSync(command, ['-V'], { stdio: 'ignore' }).error === undefined;
}
const tooling = available('ssh-keygen') && available('perl');

const STUBS: Record<string, string> = {
	// The fake directory has one line for each user: name, uid, and comment.
	dscl: `#!/usr/bin/env bash
file="$FAKE/users"
[ "$3" = "/Groups" ] && file="$FAKE/groups"
case "$2 $3" in
"-list /Users" | "-list /Groups") awk '{ print $1, $2 }' "$file" ;;
"-read /Users/"* | "-read /Groups/"*)
	case "$3" in /Groups/*) file="$FAKE/groups" ;; esac
	name="\${3#/*/}"
	attribute="\${4:-}"
	line="$(awk -v n="$name" '$1 == n' "$file")"
	[ -n "$line" ] || exit 56
	set -- $line
	case "$attribute" in
	UniqueID) [ "$2" = - ] || echo "UniqueID: $2" ;;
	Comment) echo "Comment: \${3:-}" ;;
	esac ;;
esac
`,
	dseditgroup: `#!/usr/bin/env bash
if [ "$2" = checkmember ]; then
	if grep -qx "$5 $4" "$FAKE/members"; then echo "yes $4 is a member of $5"; else echo "no $4 is not a member of $5"; exit 67; fi
fi
`,
	systemsetup: '#!/usr/bin/env bash\necho "Remote Login: $(cat "$FAKE/remotelogin")"\n',
	launchctl: '#!/usr/bin/env bash\nexit 0\n',
	// sshd listens when the fake directory has the file `listening`.
	nc: '#!/usr/bin/env bash\n[ -f "$FAKE/listening" ]\n',
};

interface Mac {
	/** The environment of a script run. */
	env: Record<string, string>;
	/** The folder of the fake directory and of the paths that the scripts read. */
	root: string;
	state: string;
}

const roots: string[] = [];
let mac: Mac;

/** A temporary Mac: stubs on PATH, a fake directory, a host key, and paths that the scripts use. */
function makeMac(): Mac {
	const root = mkdtempSync(join(tmpdir(), 'workbench-macos-'));
	roots.push(root);
	const stubs = join(root, 'stubs');
	const gnubin = join(root, 'gnubin');
	const fake = join(root, 'fake');
	for (const folder of [stubs, gnubin, fake, join(root, 'etc')]) mkdirSync(folder);
	for (const [name, source] of Object.entries(STUBS)) {
		writeFileSync(join(stubs, name), source);
		chmodSync(join(stubs, name), 0o755);
	}
	writeFileSync(join(gnubin, 'date'), '#!/bin/sh\n');
	chmodSync(join(gnubin, 'date'), 0o755);
	writeFileSync(join(fake, 'groups'), '');
	writeFileSync(join(fake, 'members'), '');
	writeFileSync(join(fake, 'remotelogin'), 'Off');
	execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host_key')]);
	const state = join(root, 'state');
	return {
		root,
		state,
		env: {
			PATH: `${stubs}:${process.env.PATH ?? ''}`,
			HOME: root,
			FAKE: fake,
			WORKBENCH_DRY_RUN: '1',
			SUDO_USER: 'admin',
			WORKBENCH_GNUBIN: gnubin,
			WORKBENCH_HOST_KEY_PUB: join(root, 'host_key.pub'),
			WORKBENCH_HOMES: join(root, 'Users'),
			WORKBENCH_SHARE: join(root, 'Users', 'Shared', 'workbench'),
			WORKBENCH_LIBEXEC: join(root, 'libexec', 'workbench'),
			WORKBENCH_SSHD_DROPIN: join(root, 'etc', '100-workbench.conf'),
			WORKBENCH_SYNTHETIC: join(root, 'etc', 'synthetic.conf'),
			WORKBENCH_ROOT_DIR: join(root, 'rootdir'),
		},
	};
}

beforeEach(() => {
	mac = makeMac();
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Run {
	code: number | null;
	out: string;
	err: string;
}

function script(name: string, args: string[], input = ''): Run {
	const result = spawnSync('bash', [join(MACOS, name), ...args], {
		env: mac.env,
		encoding: 'utf8',
		input,
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

const setup = () => script('setup.sh', [mac.state]);
const teardown = (...args: string[]) => script('teardown.sh', [...args, mac.state]);

/** The files that a dry run prints, by path. */
function writes(out: string): Map<string, string> {
	const files = new Map<string, string>();
	let path: string | undefined;
	for (const line of out.split('\n')) {
		const start = /^\+ write (\S+) mode=/.exec(line);
		if (start) path = start[1];
		else if (line.startsWith('+ end ')) path = undefined;
		else if (path !== undefined)
			files.set(path, `${files.get(path) ?? ''}${line.replace(/^\| ?/, '')}\n`);
	}
	return files;
}

/** The commands that a dry run prints, one for each line. */
const commands = (out: string): string[] =>
	out
		.split('\n')
		.filter((line) => line.startsWith('+ ') && !/^\+ (write|end) /.test(line))
		.map((line) => line.slice(2));

/** Make the fake Mac look as it does after a real setup, from the files that the dry run printed. */
function settle(out: string): void {
	const files = writes(out);
	const users = EVERY.map((name, i) => `${name} ${5000 + (name === GIT ? 900 : i)} ${MARK}`);
	writeFileSync(join(mac.root, 'fake', 'users'), `${users.join('\n')}\n`);
	writeFileSync(
		join(mac.root, 'fake', 'groups'),
		`workbench 5000 ${MARK}\nworkbench-git 5900 ${MARK}\n`,
	);
	writeFileSync(join(mac.root, 'fake', 'remotelogin'), 'On');
	writeFileSync(
		join(mac.root, 'fake', 'members'),
		`${ACCOUNTS.map((name) => `workbench ${name}`).join('\n')}\n`,
	);
	for (const [path, content] of files) {
		if (path.startsWith(join(mac.root, 'etc')) || path.startsWith(join(mac.root, 'libexec'))) {
			mkdirSync(join(path, '..'), { recursive: true });
			writeFileSync(path, content);
		}
	}
	mkdirSync(mac.env.WORKBENCH_SHARE ?? '', { recursive: true });
	mkdirSync(join(mac.root, 'libexec', 'workbench'), { recursive: true });
}

describe.skipIf(!tooling)('workstation/macos/setup.sh in a dry run', () => {
	it('makes every account, hidden, with a fixed uid, and the group of the seats', () => {
		const run = setup();
		expect(run.err).toBe('');
		expect(run.code).toBe(0);
		const made = commands(run.out);
		for (const [i, name] of EVERY.entries()) {
			const uid = name === GIT ? 5900 : 5000 + i;
			expect(made).toContain(`dscl . -create /Users/${name} UniqueID ${uid}`);
			expect(made).toContain(`dscl . -create /Users/${name} IsHidden 1`);
			expect(made).toContain(`dscl . -create /Users/${name} Comment ${MARK}`);
			expect(made).toContain(`dscl . -create /Users/${name} Password \\*`);
			expect(made).toContain(
				`dscl . -create /Users/${name} PrimaryGroupID ${name === GIT ? 5900 : 5000}`,
			);
		}
		expect(made.join('\n')).not.toContain('PrimaryGroupID 20');
		expect(made).toContain(`dseditgroup -o create -r Workbench\\ seats -i 5000 workbench`);
		expect(made).toContain(`dscl . -create /Groups/workbench Comment ${MARK}`);
		expect(made).toContain(
			`dseditgroup -o create -r Workbench\\ git\\ account -i 5900 workbench-git`,
		);
		expect(made).toContain(`dscl . -create /Groups/workbench-git Comment ${MARK}`);
		expect(made).not.toContain(`dseditgroup -o edit -a ${GIT} -t user workbench-git`);
		for (const name of ACCOUNTS)
			expect(made).toContain(`dseditgroup -o edit -a ${name} -t user workbench`);
		expect(made).not.toContain(`dseditgroup -o edit -a ${GIT} -t user workbench`);
	});

	it('names exactly the accounts in the Match block, and takes only keys', () => {
		const dropin = writes(setup().out).get(mac.env.WORKBENCH_SSHD_DROPIN ?? '') ?? '';
		const matches = dropin.split('\n').filter((line) => line.startsWith('Match '));
		expect(matches).toEqual([`Match User ${GIT}`, `Match User ${EVERY.join(',')}`]);
		expect(dropin).toContain('AuthenticationMethods publickey');
		expect(dropin).toContain('PasswordAuthentication no');
		expect(dropin).toContain('KbdInteractiveAuthentication no');
		expect(dropin).toContain(
			`Match User ${GIT}\n\tAuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys.ambion`,
		);
		expect(dropin).not.toMatch(/^(Port|ListenAddress)/m);
	});

	it('limits each key to the loopback addresses', () => {
		const files = writes(setup().out);
		for (const name of EVERY) {
			const line = files.get(join(mac.env.WORKBENCH_HOMES ?? '', name, '.ssh', 'authorized_keys'));
			const key = readFileSync(join(mac.state, 'keys', `${name}.pub`), 'utf8').trim();
			expect(line).toBe(`from="127.0.0.1,::1" ${key}\n`);
		}
	});

	it('writes a config that the loader reads, with no object store', async () => {
		expect(setup().code).toBe(0);
		const path = join(mac.state, 'macos.json');
		const loaded = await loadWorkstation(path);
		const fingerprint = execFileSync('ssh-keygen', ['-lf', join(mac.root, 'host_key.pub')], {
			encoding: 'utf8',
		}).split(' ')[1];
		const share = mac.env.WORKBENCH_SHARE ?? '';
		expect(loaded).toMatchObject({
			host: '127.0.0.1',
			port: 22,
			hostKey: fingerprint,
			gitAccount: GIT,
			layout: {
				audit: `${share}/srv/audit/audit.jsonl`,
				rooms: `${share}/srv/rooms`,
				snapshots: `${share}/srv/snapshots`,
			},
			roots: ['/datasheets', '/shared', '/attachments'],
		});
		expect(loaded.objects).toBeUndefined();
		expect(readFileSync(join(mac.state, 'macos.known_hosts'), 'utf8')).toMatch(
			/^127\.0\.0\.1 ssh-ed25519 \S+\n$/,
		);
	});

	it('writes the keys of the container layout and leaves workstation.json alone', () => {
		mkdirSync(mac.state);
		writeFileSync(join(mac.state, 'workstation.json'), '{}');
		setup();
		for (const name of EVERY) {
			expect(existsSync(join(mac.state, 'keys', name))).toBe(true);
			expect(existsSync(join(mac.state, 'keys', `${name}.pub`))).toBe(true);
		}
		expect(readFileSync(join(mac.state, 'workstation.json'), 'utf8')).toBe('{}');
	});

	it('links the three root folders in synthetic.conf, and writes the shims', () => {
		const files = writes(setup().out);
		const links = files.get(mac.env.WORKBENCH_SYNTHETIC ?? '') ?? '';
		const share = (mac.env.WORKBENCH_SHARE ?? '').slice(1);
		expect(links).toBe(
			['datasheets', 'shared', 'attachments'].map((name) => `${name}\t${share}/${name}\n`).join(''),
		);
		const bin = join(mac.env.WORKBENCH_LIBEXEC ?? '', 'bin');
		expect(files.get(join(bin, 'setsid'))).toContain('setsid --wait');
		expect(files.get(join(bin, 'flock'))).toContain('flock 9');
		expect(files.get(join(mac.env.WORKBENCH_LIBEXEC ?? '', 'state'))).toBe('remotelogin=off\n');
	});

	it('puts the shims and the GNU tools on the PATH of each seat', () => {
		const files = writes(setup().out);
		const zshenv = files.get(join(mac.env.WORKBENCH_HOMES ?? '', 'engineer', '.zshenv')) ?? '';
		expect(zshenv).toContain(
			`export PATH="${mac.env.WORKBENCH_LIBEXEC}/bin:${mac.env.WORKBENCH_GNUBIN}`,
		);
	});

	it('keeps the home of each account private, and lets the group write /shared and the audit log', () => {
		const made = commands(setup().out);
		const homes = mac.env.WORKBENCH_HOMES ?? '';
		for (const name of EVERY) {
			const group = name === GIT ? 'workbench-git' : 'workbench';
			expect(made).toContain(`install -d -m 0700 -o ${name} -g ${group} ${homes}/${name}`);
		}
		const share = mac.env.WORKBENCH_SHARE ?? '';
		expect(made).toContain(
			`install -d -m 0770 -o root -g workbench ${share}/srv/audit ${share}/shared`,
		);
		const acls = made.filter((line) => line.startsWith('chmod +a'));
		expect(acls).toHaveLength(4);
		for (const acl of acls) expect(acl).toContain('directory_inherit');
		expect(made).toContain(
			`install -d -m 0750 -o workbench-host -g workbench ${share}/srv/rooms ${share}/srv/snapshots ${share}/datasheets ${share}/attachments`,
		);
	});

	it('makes .ssh and writes the files of a seat as that seat', () => {
		const run = setup();
		const made = commands(run.out);
		const files = writes(run.out);
		const homes = mac.env.WORKBENCH_HOMES ?? '';
		for (const name of EVERY) {
			expect(made).toContain(`sudo -n -u ${name} -H install -d -m 0700 ${homes}/${name}/.ssh`);
			expect(made.join('\n')).not.toMatch(new RegExp(`^install .*${homes}/${name}/\\.ssh`, 'm'));
			const group = name === GIT ? 'workbench-git' : 'workbench';
			expect(run.out).toContain(
				`+ write ${homes}/${name}/.ssh/authorized_keys mode=0600 owner=${name}:${group}`,
			);
			expect(files.has(`${homes}/${name}/.zshenv`)).toBe(true);
		}
	});

	it('writes the comment of each user and the group before any other attribute', () => {
		const made = commands(setup().out);
		for (const name of EVERY) {
			const comment = made.indexOf(`dscl . -create /Users/${name} Comment ${MARK}`);
			expect(comment).toBe(made.indexOf(`dscl . -create /Users/${name}`) + 1);
			expect(comment).toBeLessThan(
				made.findIndex((line) => line.startsWith(`dscl . -create /Users/${name} UniqueID`)),
			);
		}
		const group = made.indexOf('dseditgroup -o create -r Workbench\\ seats -i 5000 workbench');
		expect(made[group + 1]).toBe(`dscl . -create /Groups/workbench Comment ${MARK}`);
	});

	it('adds the accounts to com.apple.access_ssh when the group exists', () => {
		writeFileSync(join(mac.root, 'fake', 'remotelogin'), 'On');
		expect(commands(setup().out).join('\n')).not.toContain('com.apple.access_ssh');
		writeFileSync(join(mac.root, 'fake', 'groups'), 'com.apple.access_ssh 399 \n');
		const made = commands(setup().out);
		for (const name of EVERY)
			expect(made).toContain(`dseditgroup -o edit -a ${name} -t user com.apple.access_ssh`);
		expect(made.join('\n')).not.toContain('-o create -q');
	});

	it('limits ssh to the accounts and the admin when it turns Remote Login on', () => {
		const run = setup();
		const made = commands(run.out);
		const create = made.indexOf('dseditgroup -o create -q com.apple.access_ssh');
		expect(create).toBeGreaterThan(-1);
		expect(made[create + 1]).toBe(`dscl . -create /Groups/com.apple.access_ssh Comment ${MARK}`);
		for (const name of [...EVERY, 'admin']) {
			const added = made.indexOf(`dseditgroup -o edit -a ${name} -t user com.apple.access_ssh`);
			expect(added).toBeGreaterThan(create);
			expect(added).toBeLessThan(made.indexOf('systemsetup -f -setremotelogin on'));
		}
		expect(run.out).toContain('com.apple.access_ssh: create it');
		expect(run.out).toContain('only these users can log in with ssh');
		const marker = join(mac.env.WORKBENCH_LIBEXEC ?? '', 'ssh-group-created');
		expect(writes(run.out).has(marker)).toBe(true);
	});

	it('leaves ssh open to the users of the Mac when Remote Login is on already', () => {
		writeFileSync(join(mac.root, 'fake', 'remotelogin'), 'On');
		const run = setup();
		expect(run.out).not.toContain('com.apple.access_ssh');
		expect(run.out).not.toContain('ssh-group-created');
	});

	it('records Remote Login as off or on from sshd when no tool gives the state', () => {
		const state = () =>
			writes(setup().out).get(join(mac.env.WORKBENCH_LIBEXEC ?? '', 'state')) ?? '';
		writeFileSync(join(mac.root, 'fake', 'remotelogin'), 'Unknown');
		expect(state()).toBe('remotelogin=off\n');
		writeFileSync(join(mac.root, 'fake', 'listening'), '');
		expect(state()).toBe('remotelogin=on\n');
	});

	it('refuses a uid that another user holds', () => {
		writeFileSync(join(mac.root, 'fake', 'users'), 'someone 5001 \n');
		const run = setup();
		expect(run.code).toBe(1);
		expect(run.err).toContain('the uid 5001 belongs to the user someone');
		expect(run.err).toContain('sudo WORKBENCH_UID_BASE=6000 bash');
	});

	it('stops before any change when the home of a new account exists', () => {
		mkdirSync(join(mac.env.WORKBENCH_HOMES ?? '', 'engineer'), { recursive: true });
		const run = setup();
		expect(run.code).toBe(1);
		expect(run.err).toContain('engineer exists, and the user engineer does not');
		expect(commands(run.out)).toEqual([]);
	});

	describe('the root links', () => {
		const rootdir = () => mac.env.WORKBENCH_ROOT_DIR ?? '';
		const target = (name: string) => `${(mac.env.WORKBENCH_SHARE ?? '').slice(1)}/${name}`;

		it.each(['Datasheets', 'SHARED', 'Attachments', 'shared'])(
			'stops before any change when /%s clashes with a root link',
			(name) => {
				mkdirSync(join(rootdir(), name), { recursive: true });
				const run = setup();
				expect(run.code).toBe(1);
				expect(run.err).toContain(`/${name} exists, and it clashes with the root link`);
				expect(run.out).toBe('');
			},
		);

		it('stops when a link of the same name leads elsewhere, or has another case', () => {
			mkdirSync(rootdir(), { recursive: true });
			symlinkSync('/tmp', join(rootdir(), 'datasheets'));
			expect(setup().code).toBe(1);
			rmSync(join(rootdir(), 'datasheets'));
			symlinkSync(target('shared'), join(rootdir(), 'Shared'));
			expect(setup().err).toContain('/Shared exists');
		});

		describe('in synthetic.conf', () => {
			const conf = () => mac.env.WORKBENCH_SYNTHETIC ?? '';

			function stopped(content: string, line: string): void {
				writeFileSync(conf(), content);
				const run = setup();
				expect(run.code).toBe(1);
				expect(run.err).toContain(`${conf()} has the line '${line}'`);
				expect(run.err).toContain('The script changed nothing.');
				expect(run.out).toBe('');
			}

			it('stops before any change when a line links a root name elsewhere', () => {
				stopped('datasheets\tsome/other/place\n', 'datasheets<tab>some/other/place');
			});

			it('stops before any change on a line that holds only a name', () => {
				stopped('data\tSystem/Volumes/Data\nshared\n', 'shared');
			});

			it('stops before any change on a name with another case', () => {
				stopped(
					`Attachments\t${target('attachments')}\n`,
					`Attachments<tab>${target('attachments')}`,
				);
			});

			it('keeps the lines that it wrote, adds the missing ones, and writes no second line', () => {
				writeFileSync(conf(), `data\tSystem/Volumes/Data\ndatasheets\t${target('datasheets')}`);
				const run = setup();
				expect(run.code).toBe(0);
				expect(writes(run.out).get(conf())).toBe(
					`data\tSystem/Volumes/Data\ndatasheets\t${target('datasheets')}\nshared\t${target('shared')}\nattachments\t${target('attachments')}\n`,
				);
			});

			it('writes nothing when every line exists', () => {
				writeFileSync(
					conf(),
					['datasheets', 'shared', 'attachments'].map((n) => `${n}\t${target(n)}\n`).join(''),
				);
				const run = setup();
				expect(run.code).toBe(0);
				expect(writes(run.out).has(conf())).toBe(false);
			});
		});

		it('accepts the links that a first run made, and other names in /', () => {
			mkdirSync(join(rootdir(), 'Library'), { recursive: true });
			for (const name of ['datasheets', 'shared', 'attachments'])
				symlinkSync(target(name), join(rootdir(), name));
			const run = setup();
			expect(run.err).toBe('');
			expect(run.code).toBe(0);
		});
	});

	describe('a folder that another user controls', () => {
		const share = () => mac.env.WORKBENCH_SHARE ?? '';
		const homes = () => mac.env.WORKBENCH_HOMES ?? '';
		const planted = () => {
			mkdirSync(join(mac.root, 'elsewhere'));
			return join(mac.root, 'elsewhere');
		};

		function stopped(run: Run, message: string): void {
			expect(run.code).toBe(1);
			expect(run.err).toContain(message);
			expect(commands(run.out)).toEqual([]);
		}

		it('makes the data folder with mkdir, and no -p, before any other change under it', () => {
			const made = commands(setup().out);
			const make = made.indexOf(`mkdir -m 0755 ${share()}`);
			expect(make).toBeGreaterThan(-1);
			expect(made.join('\n')).not.toContain('mkdir -p');
			const first = made.findIndex(
				(line) => line.startsWith('install -d') && line.includes(share()),
			);
			expect(make).toBeLessThan(first);
		});

		it('does not make a data folder that exists', () => {
			mkdirSync(share(), { recursive: true });
			chmodSync(share(), 0o755);
			expect(commands(setup().out).join('\n')).not.toContain(`mkdir -m 0755 ${share()}`);
		});

		it('stops when the data folder is a link', () => {
			mkdirSync(join(share(), '..'), { recursive: true });
			symlinkSync(planted(), share());
			stopped(setup(), `${share()} exists and is not a plain folder`);
		});

		it('stops when srv is a link', () => {
			mkdirSync(share(), { recursive: true });
			symlinkSync(planted(), join(share(), 'srv'));
			stopped(setup(), `${share()}/srv exists and is not a plain folder`);
		});

		it('stops when the data folder does not belong to root', () => {
			mkdirSync(share(), { recursive: true });
			mac.env.WORKBENCH_ROOT_UID = '4242';
			stopped(setup(), `${share()} belongs to another user than root`);
		});

		it('stops when the data folder is writable for its group', () => {
			mkdirSync(share(), { recursive: true });
			chmodSync(share(), 0o775);
			stopped(setup(), `${share()} is writable for its group or for every user`);
		});

		it('accepts a data folder that root owns, with mode 0755', () => {
			mkdirSync(join(share(), 'srv'), { recursive: true });
			chmodSync(share(), 0o755);
			chmodSync(join(share(), 'srv'), 0o755);
			expect(setup().code).toBe(0);
		});

		it('stops when a home is a link', () => {
			settle(setup().out);
			mkdirSync(homes(), { recursive: true });
			symlinkSync(planted(), join(homes(), 'engineer'));
			mac.env.WORKBENCH_OWNER_UID = String(process.getuid?.() ?? 0);
			stopped(setup(), `${join(homes(), 'engineer')} is not a plain folder`);
		});

		it('stops when .ssh is a link, for example to a folder of the system', () => {
			settle(setup().out);
			mkdirSync(join(homes(), 'researcher'), { recursive: true });
			symlinkSync(planted(), join(homes(), 'researcher', '.ssh'));
			mac.env.WORKBENCH_OWNER_UID = String(process.getuid?.() ?? 0);
			stopped(setup(), `${join(homes(), 'researcher', '.ssh')} is not a plain folder`);
		});

		it('stops when a home belongs to another user than its account', () => {
			settle(setup().out);
			mkdirSync(join(homes(), 'engineer'), { recursive: true });
			mac.env.WORKBENCH_OWNER_UID = '4242';
			stopped(setup(), `${join(homes(), 'engineer')} does not belong to the user engineer`);
		});

		it('keeps a home that its account owns, and makes only what is missing', () => {
			settle(setup().out);
			mkdirSync(join(homes(), 'engineer'), { recursive: true });
			mac.env.WORKBENCH_OWNER_UID = String(process.getuid?.() ?? 0);
			const run = setup();
			expect(run.code).toBe(0);
			const made = commands(run.out);
			expect(made.join('\n')).not.toContain(
				`-o engineer -g workbench ${join(homes(), 'engineer')}`,
			);
			expect(made).toContain(
				`sudo -n -u engineer -H install -d -m 0700 ${join(homes(), 'engineer')}/.ssh`,
			);
		});
	});

	it('reads the accounts file without its blank lines and indented comments', () => {
		const folder = join(mac.root, 'repo', 'workstation');
		mkdirSync(join(folder, 'macos'), { recursive: true });
		copyFileSync(join(MACOS, 'common.sh'), join(folder, 'macos', 'common.sh'));
		writeFileSync(join(folder, 'accounts'), '# note\n\nresearcher\n  # indented\n\t\nengineer\n\n');
		const result = spawnSync(
			'bash',
			['-c', '. "$1"; declare -p ACCOUNTS', 'sh', join(folder, 'macos', 'common.sh')],
			{ env: mac.env, encoding: 'utf8' },
		);
		expect(result.stdout).toBe('declare -a ACCOUNTS=([0]="researcher" [1]="engineer")\n');
	});

	it('refuses an account that it did not make', () => {
		writeFileSync(join(mac.root, 'fake', 'users'), 'engineer 5001 \n');
		const run = setup();
		expect(run.code).toBe(1);
		expect(run.err).toContain('the user engineer exists, and this script did not make it');
	});

	it.each(['workbench', 'workbench-git'])('refuses a group %s that it did not make', (group) => {
		writeFileSync(join(mac.root, 'fake', 'groups'), `${group} 7000 \n`);
		const run = setup();
		expect(run.code).toBe(1);
		expect(run.err).toContain(`the group ${group} exists, and this script did not make it`);
		expect(commands(run.out)).toEqual([]);
	});

	it('refuses a gid that another group holds, for the group of the git account too', () => {
		writeFileSync(join(mac.root, 'fake', 'groups'), 'other 5900 \n');
		const run = setup();
		expect(run.code).toBe(1);
		expect(run.err).toContain('the gid 5900 belongs to the group other');
		expect(commands(run.out)).toEqual([]);
	});

	it('changes nothing on a second run', () => {
		settle(setup().out);
		const again = setup();
		expect(again.code).toBe(0);
		const made = commands(again.out);
		expect(
			made.filter((line) => /^(dscl . -create|dseditgroup -o (create|edit))/.test(line)),
		).toEqual([]);
		expect(made.filter((line) => line.startsWith('chmod +a'))).toHaveLength(4);
		expect(writes(again.out).has(mac.env.WORKBENCH_SYNTHETIC ?? '')).toBe(false);
		expect(writes(again.out).has(join(mac.env.WORKBENCH_LIBEXEC ?? '', 'state'))).toBe(false);
	});
});

describe.skipIf(!tooling)('workstation/macos/teardown.sh in a dry run', () => {
	const synthetic = () => mac.env.WORKBENCH_SYNTHETIC ?? '';

	/** A Mac after setup, with a line of the admin in synthetic.conf. */
	function settled(): void {
		settle(setup().out);
		const added = readFileSync(synthetic(), 'utf8');
		writeFileSync(synthetic(), `data\tSystem/Volumes/Data\n${added}`);
	}

	it('deletes every account and the group, and removes the files that setup wrote', () => {
		settled();
		const run = teardown('--yes');
		expect(run.err).toBe('');
		expect(run.code).toBe(0);
		const removed = commands(run.out);
		for (const name of EVERY) expect(removed).toContain(`sysadminctl -deleteUser ${name}`);
		expect(removed).toContain('dseditgroup -o delete workbench');
		expect(removed).toContain('dseditgroup -o delete workbench-git');
		expect(removed).toContain(`rm -f ${mac.env.WORKBENCH_SSHD_DROPIN}`);
		expect(removed).toContain(`rm -rf ${mac.env.WORKBENCH_LIBEXEC}`);
		expect(removed).toContain(`rm -rf ${mac.env.WORKBENCH_SHARE}`);
		expect(removed).toContain(
			`as_admin rm -f ${mac.state}/macos.json ${mac.state}/macos.known_hosts`,
		);
	});

	it('removes only the lines of synthetic.conf that setup added', () => {
		settled();
		const rewritten = writes(teardown('--yes').out).get(synthetic());
		expect(rewritten).toBe('data\tSystem/Volumes/Data\n');
	});

	it('removes the file when setup added every line of it', () => {
		settle(setup().out);
		expect(commands(teardown('--yes').out)).toContain(`rm -f ${synthetic()}`);
	});

	it('puts Remote Login back to off, and leaves it on when it was on', () => {
		settled();
		expect(commands(teardown('--yes').out)).toContain('systemsetup -f -setremotelogin off');
		writeFileSync(join(mac.env.WORKBENCH_LIBEXEC ?? '', 'state'), 'remotelogin=on\n');
		expect(commands(teardown('--yes').out).join('\n')).not.toContain('setremotelogin');
	});

	it('leaves an account that setup did not make, and the keys of the state folder', () => {
		settled();
		writeFileSync(
			join(mac.root, 'fake', 'users'),
			`engineer 5001 \nalice 501 \n${EVERY.filter((name) => name !== 'engineer')
				.map((name) => `${name} 5002 ${MARK}`)
				.join('\n')}\n`,
		);
		const run = teardown('--yes');
		const removed = commands(run.out).join('\n');
		expect(removed).not.toContain('deleteUser engineer');
		expect(removed).not.toContain('alice');
		expect(removed).not.toContain('/keys');
		expect(run.err).toContain('the user engineer exists, and setup.sh did not make it');
	});

	it('removes the accounts from com.apple.access_ssh', () => {
		settled();
		writeFileSync(
			join(mac.root, 'fake', 'groups'),
			`workbench 5000 ${MARK}\ncom.apple.access_ssh 399 \n`,
		);
		writeFileSync(
			join(mac.root, 'fake', 'members'),
			`${EVERY.map((name) => `com.apple.access_ssh ${name}`).join('\n')}\ncom.apple.access_ssh admin\n`,
		);
		const removed = commands(teardown('--yes').out);
		for (const name of EVERY)
			expect(removed).toContain(`dseditgroup -o edit -d ${name} -t user com.apple.access_ssh`);
		expect(removed.join('\n')).not.toContain('-d admin');
	});

	it('deletes com.apple.access_ssh when setup made it, and not when it did not', () => {
		settled();
		const groups = join(mac.root, 'fake', 'groups');
		writeFileSync(groups, `workbench 5000 ${MARK}\ncom.apple.access_ssh 399 ${MARK}\n`);
		const marker = join(mac.env.WORKBENCH_LIBEXEC ?? '', 'ssh-group-created');
		expect(existsSync(marker)).toBe(true);
		const run = teardown('--yes');
		expect(commands(run.out)).toContain('dseditgroup -o delete com.apple.access_ssh');
		expect(run.out).toContain('the group com.apple.access_ssh, which setup.sh made');
		writeFileSync(groups, `workbench 5000 ${MARK}\ncom.apple.access_ssh 399 \n`);
		const kept = teardown('--yes');
		expect(commands(kept.out).join('\n')).not.toContain('delete com.apple.access_ssh');
		expect(kept.err).toContain('its comment is gone');
		rmSync(marker);
		writeFileSync(groups, `workbench 5000 ${MARK}\ncom.apple.access_ssh 399 ${MARK}\n`);
		expect(commands(teardown('--yes').out).join('\n')).not.toContain('delete com.apple.access_ssh');
	});

	it('removes a record that setup left half made, with a comment and no id', () => {
		settled();
		writeFileSync(
			join(mac.root, 'fake', 'users'),
			`engineer - ${MARK}\n${EVERY.filter((name) => name !== 'engineer')
				.map((name) => `${name} 5002 ${MARK}`)
				.join('\n')}\n`,
		);
		const removed = commands(teardown('--yes').out);
		expect(removed).toContain('sysadminctl -deleteUser engineer');
		expect(removed.join('\n')).not.toContain("pkill -KILL -u ''");
	});

	it('asks before it removes, and removes nothing on another answer than yes', () => {
		settled();
		const refused = script('teardown.sh', [mac.state], 'no\n');
		expect(refused.code).toBe(1);
		expect(refused.out).toContain('Nothing removed.');
		expect(commands(refused.out)).toEqual([]);
	});

	it('asks a second question before it removes the data folder', () => {
		settled();
		const kept = script('teardown.sh', [mac.state], 'yes\nno\n');
		expect(commands(kept.out)).not.toContain(`rm -rf ${mac.env.WORKBENCH_SHARE}`);
		expect(kept.out).toContain('kept');
		const removed = script('teardown.sh', [mac.state], 'yes\nyes\n');
		expect(commands(removed.out)).toContain(`rm -rf ${mac.env.WORKBENCH_SHARE}`);
	});

	it('finds nothing to do on a Mac without a workstation', () => {
		const run = teardown('--yes');
		expect(run.code).toBe(0);
		expect(run.out).toContain('Nothing to do');
		expect(commands(run.out)).toEqual([]);
	});
});

describe.skipIf(!tooling)('the shims of setsid and flock', () => {
	const shim = (name: string) => join(MACOS, 'shims', name);

	it('setsid --wait gives the exit status of the command, in a new process group', () => {
		const status = spawnSync(shim('setsid'), ['--wait', 'bash', '-c', 'exit 3']);
		expect(status.status).toBe(3);
		const group = spawnSync(shim('setsid'), [
			'--wait',
			'bash',
			'-c',
			'echo "$$ $(ps -o pgid= -p $$)"',
		]);
		const [pid, pgid] = group.stdout.toString().trim().split(/\s+/);
		expect(pgid).toBe(pid);
	});

	it('setsid reports a command that ends on a signal, and a command that is missing', () => {
		const killed = spawnSync(shim('setsid'), ['--wait', 'bash', '-c', 'kill -9 $$'], {
			encoding: 'utf8',
		});
		expect(killed.status).toBe(1);
		expect(killed.stderr).toMatch(/^setsid: child \d+ did not exit normally$/m);
		const missing = spawnSync(shim('setsid'), ['--wait', 'no-such-command-here'], {
			encoding: 'utf8',
		});
		expect(missing.status).toBe(127);
		expect(missing.stderr).toBe(
			'setsid: failed to execute no-such-command-here: No such file or directory\n',
		);
	});

	it('flock 9 locks the descriptor for as long as the shell holds it', () => {
		const lock = join(mac.root, 'lock');
		const body = `exec 9>>${lock}; ${shim('flock')} 9 && echo locked; (exec 8>>${lock}; ${shim('flock')} -n 8 && echo second || echo blocked)`;
		const result = spawnSync('bash', ['-c', body], { encoding: 'utf8' });
		expect(result.stdout).toBe('locked\nblocked\n');
	});
});

describe('the scripts as bash reads them', () => {
	it.each(['setup.sh', 'teardown.sh', 'common.sh'])('%s has valid syntax', (name) => {
		expect(spawnSync('bash', ['-n', join(MACOS, name)]).status).toBe(0);
	});
});
