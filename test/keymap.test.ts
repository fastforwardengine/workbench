import { describe, expect, it } from 'vitest';
import {
	actOf,
	type Binding,
	bindingLabel,
	type Chord,
	KEYMAP,
	keyLabel,
	matches,
} from '../src/terminal/state/keymap.ts';

const key = (name: string, extra: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => ({
	name,
	...extra,
});

describe('actOf', () => {
	it('tells Ctrl+R from r', () => {
		expect(actOf('composer', key('r', { ctrl: true }))).toBe('rooms');
		expect(actOf('composer', key('r'))).toBeUndefined();
		expect(actOf('refs', key('r'))).toBe('back');
		expect(actOf('refs', key('r', { ctrl: true }))).toBeUndefined();
	});

	it('ignores Shift unless the chord names it', () => {
		expect(actOf('composer', key('?', { shift: true }))).toBe('keys');
		expect(actOf('composer', key('?'))).toBe('keys');
		expect(actOf('refs', key('k', { shift: true }))).toBe('up');
		expect(actOf('composer', key('return'))).toBe('send');
		expect(actOf('composer', key('return', { shift: true }))).toBe('newline');
		expect(actOf('composer', key('return', { meta: true }))).toBe('newline');
		expect(actOf('composer', key('linefeed'))).toBe('newline');
		expect(actOf('everywhere', key('c', { ctrl: true, shift: true }))).toBeUndefined();
	});

	it('needs the exact Ctrl and Alt state', () => {
		expect(actOf('everywhere', key('c', { ctrl: true }))).toBe('interrupt');
		expect(actOf('everywhere', key('d', { ctrl: true }))).toBe('quit');
		expect(actOf('everywhere', key('c'))).toBeUndefined();
		expect(actOf('processes', key('x', { meta: true }))).toBeUndefined();
		expect(actOf('processes', key('x'))).toBe('cancel');
		expect(actOf('processes', key('k'))).toBe('up');
		expect(actOf('files', key('k'))).toBeUndefined();
	});

	it('finds the keys of the sheet', () => {
		for (const name of ['?', 'q']) expect(actOf('sheet', key(name))).toBe('close');
		expect(actOf('sheet', key('escape'))).toBe('back');
	});

	it('finds the keys of the dock', () => {
		expect(actOf('composer', key('o', { ctrl: true }))).toBe('dock');
		expect(actOf('dock', key('o', { ctrl: true }))).toBe('leave');
		expect(actOf('dock', key('tab'))).toBe('cycle');
		expect(actOf('dock', key('o'))).toBeUndefined();
		expect(actOf('processes', key('escape'))).toBe('back');
		expect(actOf('processes', key('q'))).toBe('close');
		expect(actOf('files', key('q'))).toBeUndefined();
	});
});

describe('keyLabel', () => {
	it('names each key as the sheet shows it', () => {
		expect(keyLabel({ name: 'return' })).toBe('Enter');
		expect(keyLabel({ name: 'linefeed' })).toBe('Ctrl+J');
		expect(keyLabel({ name: 'escape' })).toBe('Esc');
		expect(keyLabel({ name: 'pageup' })).toBe('PgUp');
		expect(keyLabel({ name: 'pagedown' })).toBe('PgDn');
		expect(keyLabel({ name: 'up' })).toBe('↑');
		expect(keyLabel({ name: 'down' })).toBe('↓');
		expect(keyLabel({ name: 'left' })).toBe('←');
		expect(keyLabel({ name: 'right' })).toBe('→');
		expect(keyLabel({ name: 'space' })).toBe('Space');
		expect(keyLabel({ name: 'f13' })).toBe('F13');
		expect(keyLabel({ name: 'tab' })).toBe('Tab');
		expect(keyLabel({ name: 'backspace' })).toBe('Backspace');
		expect(keyLabel({ name: '?' })).toBe('?');
		expect(keyLabel({ name: 'x' })).toBe('x');
	});

	it('writes the modifiers before the key', () => {
		expect(keyLabel({ name: 'r', ctrl: true })).toBe('Ctrl+R');
		expect(keyLabel({ name: 'return', meta: true })).toBe('Alt+Enter');
		expect(keyLabel({ name: 'return', shift: true })).toBe('Shift+Enter');
		expect(keyLabel({ name: 'return', shift: false })).toBe('Enter');
	});

	it('joins the chords of a binding', () => {
		expect(bindingLabel(KEYMAP.composer.bindings.newline)).toBe('Ctrl+J Shift+Enter Alt+Enter');
		expect(bindingLabel(KEYMAP.composer.bindings.keys)).toBe('?');
	});
});

describe('the table', () => {
	/** The chord as a string: the modifiers that the key must have, and Shift only when named. */
	const signature = (chord: Chord) =>
		`${chord.name}:${chord.ctrl ?? false}:${chord.meta ?? false}:${chord.shift ?? 'any'}`;

	it('gives no two bindings of one scope the same chord', () => {
		for (const section of Object.values(KEYMAP)) {
			const seen = new Set<string>();
			for (const binding of Object.values<Binding>(section.bindings))
				for (const chord of binding.keys) {
					expect(seen.has(signature(chord)), `${section.title}: ${keyLabel(chord)}`).toBe(false);
					seen.add(signature(chord));
				}
		}
	});

	it('gives every binding a chord and a sentence', () => {
		for (const section of Object.values(KEYMAP))
			for (const binding of Object.values<Binding>(section.bindings)) {
				expect(binding.keys.length).toBeGreaterThan(0);
				expect(binding.does).not.toBe('');
			}
	});

	it('matches a chord by its name', () => {
		expect(matches({ name: 'space' }, key('space'))).toBe(true);
		expect(matches({ name: 'space' }, key('tab'))).toBe(false);
	});
});
