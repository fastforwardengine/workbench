/**
 * The checks of the sensor protocol, version 2, for the sensor servers of the templates.
 * Ambion defines the protocol in `docs/sensors.md` and ships no suite for it.
 */
import { createHash } from 'node:crypto';
import { expect } from 'vitest';

/** One reply of a sensor server. */
export interface SensorReply {
	status: number;
	contentType: string | null;
	body: unknown;
	bytes: Uint8Array;
}

/** One sensor of the index, as the test expects it. */
export interface SensorExpectation {
	name: string;
	spans: boolean;
}

/** The span of the tests. Both ends have three digits of milliseconds. */
const SPAN = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' };

/** Send one request to the server at `root`, and keep the body as JSON when it parses. */
export async function send(root: string, path: string, method = 'GET'): Promise<SensorReply> {
	const response = await fetch(`${root}${path}`, { method });
	const bytes = new Uint8Array(await response.arrayBuffer());
	const text = Buffer.from(bytes).toString('utf8');
	const isJson = response.headers.get('content-type')?.startsWith('application/json');
	return {
		status: response.status,
		contentType: response.headers.get('content-type'),
		body: isJson ? JSON.parse(text) : undefined,
		bytes,
	};
}

/** Expect a JSON error of the protocol: `api`, a `code`, and a `message`. */
function expectError(reply: SensorReply, status: number, code: string) {
	expect(reply.status).toBe(status);
	expect(reply.contentType).toBe('application/json');
	expect(reply.body).toMatchObject({ api: 2, code });
	expect(typeof (reply.body as { message: unknown }).message).toBe('string');
}

/** The observations of a reply that must hold status 200 and `api: 2`. */
export function observationsOf(reply: SensorReply): { at: string; parts: { kind: string }[] }[] {
	expect(reply.status).toBe(200);
	expect(reply.contentType).toBe('application/json');
	expect(reply.body).toMatchObject({ api: 2 });
	return (reply.body as { observations: { at: string; parts: { kind: string }[] }[] }).observations;
}

/** Fetch a file by its digest, and check that the bytes match the digest. */
export async function fileOf(root: string, digest: string): Promise<Buffer> {
	const reply = await send(root, `/files/${digest}`);
	expect(reply.status).toBe(200);
	const bytes = Buffer.from(reply.bytes);
	expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
	return bytes;
}

/** Check the index: `api`, the source, and each sensor with its name, description, and spans. */
export async function expectIndex(root: string, repository: string, sensors: SensorExpectation[]) {
	const reply = await send(root, '/');
	expect(reply.status).toBe(200);
	expect(reply.contentType).toBe('application/json');
	const index = reply.body as {
		api: number;
		source: { repository: string };
		sensors: { name: string; description: string; spans: boolean }[];
	};
	expect(index.api).toBe(2);
	expect(index.source.repository).toBe(repository);
	expect(index.sensors.map(({ name, spans }) => ({ name, spans }))).toEqual(sensors);
	for (const sensor of index.sensors) expect(sensor.description.length).toBeGreaterThan(0);
}

/** Check the answers of one sensor to a latest read, a valid span, and malformed queries. */
export async function expectSensor(root: string, sensor: SensorExpectation) {
	const path = `/${sensor.name}/observe`;
	for (const observation of observationsOf(await send(root, path))) {
		expect(observation.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		expect(observation.parts.length).toBeGreaterThan(0);
	}
	const span = `?from=${SPAN.from}&to=${SPAN.to}`;
	const spanReply = await send(root, `${path}${span}`);
	if (sensor.spans) observationsOf(spanReply);
	else expectError(spanReply, 422, 'unavailable');
	const malformed = [
		`?from=${SPAN.from}`,
		`?to=${SPAN.to}`,
		`?from=${SPAN.to}&to=${SPAN.from}`,
		`?from=${SPAN.from}&to=${SPAN.from}`,
		'?from=2026-01-01&to=2026-01-02',
		`?from=${SPAN.from}&to=${SPAN.to}&extra=1`,
	];
	for (const query of malformed) expectError(await send(root, `${path}${query}`), 400, 'invalid');
}

/** Check the errors for an unknown sensor, an unknown path, an unknown file, and a write method. */
export async function expectUnknown(root: string) {
	expectError(await send(root, '/nothing/observe'), 404, 'unknown');
	expectError(await send(root, '/nothing'), 404, 'unknown');
	expectError(await send(root, `/files/${'0'.repeat(64)}`), 404, 'unknown');
	expectError(await send(root, '/camera/observe', 'POST'), 404, 'unknown');
}
