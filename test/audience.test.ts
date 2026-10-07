/** What the composer chip says that a message reaches. */
import { describe, expect, it } from 'vitest';
import { audienceOf } from '../src/terminal/state/audience.ts';
import { view } from './fake-host.ts';

const team = [{ name: 'engineer' }, { name: 'researcher' }];

const agent = (name: string, attention: string) => ({
	kind: 'agent',
	name,
	identity: name,
	status: 'idle',
	attention,
});

/** A root room that seats the Engineer at `broadcast` and the Researcher at `named`. */
const seated = view('build', {
	unavailable: [],
	participants: [agent('engineer', 'broadcast'), agent('researcher', 'named')],
});

/** A root room that seats the Engineer only. */
const engineerOnly = view('build', {
	unavailable: [],
	participants: [agent('engineer', 'broadcast')],
});

describe('the audience of a message', () => {
	it('is the seats at broadcast for plain text', () => {
		expect(audienceOf('hello', team, seated)).toEqual({ mode: 'plain', names: ['engineer'] });
		expect(audienceOf('', team, seated)).toEqual({ mode: 'plain', names: ['engineer'] });
	});

	it('is nobody when no seat listens at broadcast, or no room is open', () => {
		const quiet = view('build', {
			unavailable: [],
			participants: [agent('researcher', 'named')],
		});
		expect(audienceOf('hello', team, quiet)).toEqual({ mode: 'plain', names: [] });
		expect(audienceOf('hello', team, undefined)).toEqual({ mode: 'plain', names: [] });
	});

	it('is the named seat for @name', () => {
		expect(audienceOf('@engineer check the diode', team, seated)).toEqual({
			mode: 'mention',
			names: ['engineer'],
		});
		expect(audienceOf('@Researcher, look', team, seated)).toEqual({
			mode: 'mention',
			names: ['researcher'],
		});
	});

	it('notes that the host seats a specialist that the room has not seated', () => {
		expect(audienceOf('@researcher look', team, engineerOnly)).toEqual({
			mode: 'mention',
			names: ['researcher'],
			note: 'seats first',
		});
	});

	it('notes a seat that has no login, before the seat note', () => {
		const noLogin = view('build', {
			unavailable: ['engineer', 'researcher'],
			participants: [agent('engineer', 'broadcast')],
		});
		expect(audienceOf('@engineer hi', team, noLogin).note).toBe('no login');
		expect(audienceOf('@researcher hi', team, noLogin).note).toBe('no login');
	});

	it('is nobody for a name that is no seat', () => {
		expect(audienceOf('@nobody hi', team, seated)).toEqual({ mode: 'plain', names: [] });
		expect(audienceOf('@eng', team, seated)).toEqual({ mode: 'plain', names: [] });
	});

	it('reads // and @@ as plain text', () => {
		expect(audienceOf('//shared/kit.md', team, seated).mode).toBe('plain');
		expect(audienceOf('@@engineer', team, seated)).toEqual({ mode: 'plain', names: ['engineer'] });
	});

	it('reads a slash as a command with no audience', () => {
		expect(audienceOf('/files', team, seated)).toEqual({ mode: 'command', names: [] });
		expect(audienceOf('/', team, seated)).toEqual({ mode: 'command', names: [] });
		expect(audienceOf('/nonsense', team, seated)).toEqual({ mode: 'command', names: [] });
	});

	it('names the twins in a breakout room, and no root seat', () => {
		const breakout = view('build-scan', {
			unavailable: [],
			breakout: { parent: 'build', opener: 'engineer', state: 'running' },
			participants: [agent('engineer-bg', 'broadcast'), agent('researcher-bg', 'named')],
		});
		expect(audienceOf('hello', team, breakout)).toEqual({
			mode: 'plain',
			names: ['engineer-bg'],
		});
		expect(audienceOf('@researcher-bg look', team, breakout)).toEqual({
			mode: 'mention',
			names: ['researcher-bg'],
		});
		expect(audienceOf('@engineer look', team, breakout)).toEqual({ mode: 'plain', names: [] });
	});
});
