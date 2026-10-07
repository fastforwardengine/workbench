import { describe, expect, it } from 'vitest';
import { LayerStack } from '../src/terminal/state/layers.ts';

describe('the layer stack', () => {
	it('opens a layer on top and keeps the tabs in a fixed order', () => {
		const stack = new LayerStack();
		stack.raise('camera');
		stack.raise('files');
		expect(stack.top()).toBe('files');
		expect(stack.tabs()).toEqual(['files', 'camera']);
	});

	it('puts an open layer on top and keeps the others', () => {
		const stack = new LayerStack();
		for (const id of ['files', 'processes', 'camera'] as const) stack.raise(id);
		stack.raise('files');
		expect(stack.top()).toBe('files');
		expect(stack.tabs()).toEqual(['files', 'processes', 'camera']);
	});

	it('shows the layer that was on top before when the top layer closes', () => {
		const stack = new LayerStack();
		for (const id of ['files', 'processes', 'camera'] as const) stack.raise(id);
		stack.raise('files');
		stack.close('files');
		expect(stack.top()).toBe('camera');
		stack.close('camera');
		expect(stack.top()).toBe('processes');
		stack.close('processes');
		expect(stack.top()).toBeUndefined();
	});

	it('cycles through the tabs and wraps', () => {
		const stack = new LayerStack();
		for (const id of ['files', 'processes', 'camera'] as const) stack.raise(id);
		expect(stack.next()).toBe('files');
		stack.raise('files');
		expect(stack.next()).toBe('processes');
		stack.raise('processes');
		stack.raise('camera');
		expect(stack.next()).toBe('files');
	});

	it('keeps a layer that does not fit open, and never makes it the top layer or a tab', () => {
		const stack = new LayerStack();
		stack.raise('files');
		stack.raise('camera');
		const fits = (id: string) => id !== 'camera';
		expect(stack.top(fits)).toBe('files');
		expect(stack.tabs(fits)).toEqual(['files']);
		expect(stack.next(fits)).toBe('files');
		expect(stack.has('camera')).toBe(true);
		expect(stack.top()).toBe('camera');
	});

	it('has no next layer when none is open', () => {
		const stack = new LayerStack();
		expect(stack.next()).toBeUndefined();
		stack.raise('keys');
		stack.clear();
		expect(stack.top()).toBeUndefined();
	});
});
