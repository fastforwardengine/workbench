import { parseSnapshotUri } from '@ambionframework/ambion';
import { WORKSPACE } from './refs.ts';

/** One frame of a sensor observation: the snapshot ref of its picture, and when the sensor saw it. */
export interface ManifestFrame {
	ref: string;
	at: string;
	mediaType: string;
}

/** The frames of a sensor observation manifest, with the sensor that made them. */
export interface ManifestFrames {
	sensor: string;
	frames: ManifestFrame[];
}

/** The most frames that the panel reads from one manifest. */
const MAX_FRAMES = 64;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The form of a qualified sensor name, as Ambion checks it at retention. */
const SENSOR = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** The form of an ISO 8601 time in UTC, as a sensor reports it. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The ref of each file by digest. A ref counts when it names a snapshot of this workspace with that digest. */
function refsByDigest(files: unknown): Map<string, string> {
	const refs = new Map<string, string>();
	if (!Array.isArray(files)) return refs;
	for (const file of files) {
		if (!isRecord(file) || typeof file.digest !== 'string' || typeof file.ref !== 'string')
			continue;
		const named = parseSnapshotUri(file.ref);
		if (named?.workspace === WORKSPACE && named.digest === file.digest)
			refs.set(file.digest, file.ref);
	}
	return refs;
}

/** The frame that one part holds, or `undefined` for another kind of part or an unknown file. */
function partFrame(
	part: unknown,
	at: string,
	refs: Map<string, string>,
): ManifestFrame | undefined {
	if (!isRecord(part) || part.kind !== 'frame') return undefined;
	if (typeof part.file !== 'string' || typeof part.mediaType !== 'string') return undefined;
	const ref = refs.get(part.file);
	if (ref === undefined || !IMAGE_TYPES.has(part.mediaType)) return undefined;
	return { ref, at, mediaType: part.mediaType };
}

/** The picture parts of one observation, each with the observation time. */
function observationFrames(observation: unknown, refs: Map<string, string>): ManifestFrame[] {
	if (!isRecord(observation) || typeof observation.at !== 'string') return [];
	if (!TIME.test(observation.at)) return [];
	if (!Array.isArray(observation.parts)) return [];
	const at = observation.at;
	return observation.parts
		.map((part) => partFrame(part, at, refs))
		.filter((frame): frame is ManifestFrame => frame !== undefined);
}

/**
 * The frames of a version 1 sensor observation manifest, in the order of the
 * observations. The result is `undefined` when the bytes are not such a
 * manifest. The manifest comes from an agent, so a frame counts only when its
 * digest has a file entry whose ref names a snapshot of this workspace.
 */
export function parseManifestFrames(bytes: Uint8Array): ManifestFrames | undefined {
	let manifest: unknown;
	try {
		manifest = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
	if (!isRecord(manifest) || manifest.api !== 1 || typeof manifest.sensor !== 'string')
		return undefined;
	if (!SENSOR.test(manifest.sensor)) return undefined;
	if (!Array.isArray(manifest.observations)) return undefined;
	const refs = refsByDigest(manifest.files);
	const frames = manifest.observations
		.flatMap((observation) => observationFrames(observation, refs))
		.slice(0, MAX_FRAMES);
	return { sensor: manifest.sensor, frames };
}
