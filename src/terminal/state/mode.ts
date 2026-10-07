/**
 * Which surface takes the keys: the composer, the refs, the actions of the cameras,
 * or the top layer of the dock. The conversation keeps the keys of the composer
 * until the person gives them to one of the others.
 */
export type Mode = 'compose' | 'refs' | 'actions' | 'dock';
