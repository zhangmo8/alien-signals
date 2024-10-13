export interface IEffect {
	nextNotify: IEffect | undefined;
	notify(): void;
}

export interface Dependency {
	subs: Link | undefined;
	subsTail: Link | undefined;
	subVersion: number;
	update?(): void;
}

export interface Subscriber {
	/**
	 * Represents either the version or the dirty level of the dependency.
	 * 
	 * - When tracking is active, this property holds the version number.
	 * - When tracking is not active, this property holds the dirty level.
	 */
	versionOrDirtyLevel: number | DirtyLevels;
	deps: Link | undefined;
	depsTail: Link | undefined;
}

export interface Link {
	dep: Dependency;
	sub: Subscriber & ({} | IEffect | Dependency);
	prevSubOrUpdate: Link | undefined;
	nextSub: Link | undefined;
	nextDep: Link | undefined;
	queuedPropagateOrNextReleased: Link | undefined;
}

export const enum DirtyLevels {
	None,
	SideEffectsOnly,
	MaybeDirty,
	Dirty,
	Released,
}

export namespace System {

	export let activeDepsSub: Subscriber | undefined = undefined;
	export let activeEffectsSub: Subscriber | undefined = undefined;
	export let activeDepsSubsDepth = 0;
	export let activeEffectsSubsDepth = 0;
	export let batchDepth = 0;
	export let lastSubVersion = DirtyLevels.Released + 1;
	export let queuedEffects: IEffect | undefined = undefined;
	export let queuedEffectsTail: IEffect | undefined = undefined;

	export function startBatch() {
		batchDepth++;
	}

	export function endBatch() {
		batchDepth--;
		while (batchDepth === 0 && queuedEffects !== undefined) {
			const effect = queuedEffects;
			const queuedNext = queuedEffects.nextNotify;
			if (queuedNext !== undefined) {
				queuedEffects.nextNotify = undefined;
				queuedEffects = queuedNext;
			} else {
				queuedEffects = undefined;
				queuedEffectsTail = undefined;
			}
			effect.notify();
		}
	}
}

export namespace Link {

	export let pool: Link | undefined = undefined;

	export function get(dep: Dependency, sub: Subscriber): Link {
		if (pool !== undefined) {
			const link = pool;
			pool = link.queuedPropagateOrNextReleased;
			link.queuedPropagateOrNextReleased = undefined;
			link.dep = dep;
			link.sub = sub;
			return link;
		} else {
			return {
				dep,
				sub,
				prevSubOrUpdate: undefined,
				nextSub: undefined,
				nextDep: undefined,
				queuedPropagateOrNextReleased: undefined,
			};
		}
	}
}

export namespace Dependency {

	const system = System;

	export let propagate = fastPropagate;

	export function setPropagationMode(mode: 'strict' | 'fast') {
		propagate = mode === 'strict' ? strictPropagate : fastPropagate;
	}

	export function linkDepsSub(dep: Dependency) {
		if (system.activeDepsSubsDepth === 0) {
			return false;
		}
		const sub = system.activeDepsSub!;
		const subVersion = sub.versionOrDirtyLevel;
		if (dep.subVersion === subVersion) {
			return true;
		}
		dep.subVersion = subVersion;

		const depsTail = sub.depsTail;
		const old = depsTail !== undefined
			? depsTail.nextDep
			: sub.deps;

		if (old === undefined || old.dep !== dep) {
			const newLink = Link.get(dep, sub);
			if (old !== undefined) {
				newLink.nextDep = old;
			}
			if (depsTail === undefined) {
				sub.depsTail = sub.deps = newLink;
			} else {
				sub.depsTail = depsTail.nextDep = newLink;
			}
			if (dep.subs === undefined) {
				dep.subs = newLink;
				dep.subsTail = newLink;
			} else {
				const oldTail = dep.subsTail!;
				newLink.prevSubOrUpdate = oldTail;
				oldTail.nextSub = newLink;
				dep.subsTail = newLink;
			}
		} else {
			sub.depsTail = old;
		}
		return true;
	}

	export function linkEffectsSub(dep: Dependency) {
		if (system.activeEffectsSubsDepth === 0) {
			return false;
		}
		const sub = system.activeEffectsSub!;
		const subVersion = sub.versionOrDirtyLevel;
		if (dep.subVersion === subVersion) {
			return true;
		}
		dep.subVersion = subVersion;

		const depsTail = sub.depsTail;
		const old = depsTail !== undefined
			? depsTail.nextDep
			: sub.deps;

		if (old === undefined || old.dep !== dep) {
			const newLink = Link.get(dep, sub);
			if (old !== undefined) {
				newLink.nextDep = old;
			}
			if (depsTail === undefined) {
				sub.depsTail = sub.deps = newLink;
			} else {
				sub.depsTail = depsTail.nextDep = newLink;
			}
			if (dep.subs === undefined) {
				dep.subs = newLink;
				dep.subsTail = newLink;
			} else {
				const oldTail = dep.subsTail!;
				newLink.prevSubOrUpdate = oldTail;
				oldTail.nextSub = newLink;
				dep.subsTail = newLink;
			}
		} else {
			sub.depsTail = old;
		}
		return true;
	}

	export function strictPropagate(dep: Dependency) {
		let depIsEffect = false;
		let link = dep.subs;
		let dirtyLevel = DirtyLevels.Dirty;
		let depth = 0;

		top: while (true) {

			while (link !== undefined) {
				const sub = link.sub;
				const subDirtyLevel = sub.versionOrDirtyLevel;

				if (subDirtyLevel < dirtyLevel) {
					sub.versionOrDirtyLevel = dirtyLevel;
				}

				if (subDirtyLevel === DirtyLevels.None) {
					const subIsEffect = 'notify' in sub;

					if ('subs' in sub && sub.subs !== undefined) {
						sub.deps!.queuedPropagateOrNextReleased = link;
						dep = sub;
						depIsEffect = subIsEffect;
						link = sub.subs;
						if (subIsEffect) {
							dirtyLevel = DirtyLevels.SideEffectsOnly;
						} else {
							dirtyLevel = DirtyLevels.MaybeDirty;
						}
						depth++;

						continue top;
					} else if (subIsEffect) {
						const queuedEffectsTail = system.queuedEffectsTail;

						if (queuedEffectsTail !== undefined) {
							queuedEffectsTail.nextNotify = sub;
							system.queuedEffectsTail = sub;
						} else {
							system.queuedEffectsTail = sub;
							system.queuedEffects = sub;
						}
					}
				}

				link = link.nextSub;
			}

			const depDeps = (dep as Dependency & Subscriber).deps;
			if (depDeps !== undefined) {

				const prevLink = depDeps.queuedPropagateOrNextReleased;

				if (prevLink !== undefined) {
					depDeps.queuedPropagateOrNextReleased = undefined;
					dep = prevLink.dep;
					depIsEffect = 'notify' in dep;
					link = prevLink.nextSub;
					depth--;

					if (depth === 0) {
						dirtyLevel = DirtyLevels.Dirty;
					} else if (depIsEffect) {
						dirtyLevel = DirtyLevels.SideEffectsOnly;
					} else {
						dirtyLevel = DirtyLevels.MaybeDirty;
					}

					const prevSub = prevLink.sub;

					if ('notify' in prevSub) {
						const queuedEffectsTail = system.queuedEffectsTail;

						if (queuedEffectsTail !== undefined) {
							queuedEffectsTail.nextNotify = prevSub;
							system.queuedEffectsTail = prevSub;
						} else {
							system.queuedEffectsTail = prevSub;
							system.queuedEffects = prevSub;
						}
					}

					continue;
				}
			}

			break;
		}
	}

	/**
	 * @example Original
		export function fastPropagate(dep: Dependency, dirtyLevel = DirtyLevels.Dirty) {
			let link = dep.subs;

			while (link !== undefined) {
				const sub = link.sub;
				const subDirtyLevel = sub.versionOrDirtyLevel;

				if (subDirtyLevel < dirtyLevel) {
					sub.versionOrDirtyLevel = dirtyLevel;
				}

				if (subDirtyLevel === DirtyLevels.None) {
					if ('notify' in sub) {
						const queuedEffectsTail = system.queuedEffectsTail;

						if (queuedEffectsTail !== undefined) {
							queuedEffectsTail.nextNotify = sub;
							system.queuedEffectsTail = sub;
						} else {
							system.queuedEffectsTail = sub;
							system.queuedEffects = sub;
						}
					} else if ('subs' in sub) {
						fastPropagate(sub, DirtyLevels.MaybeDirty);
					}
				}

				link = link.nextSub;
			}
		}
	 */
	export function fastPropagate(dep: Dependency) {
		let subsHead = dep.subs!;
		if (subsHead === undefined) {
			return;
		}

		let dirtyLevel = DirtyLevels.Dirty;
		let lastSubs = subsHead;
		let link = subsHead;
		let remainingQuantity = 0;

		while (true) {
			const sub = link.sub;
			const subDirtyLevel = sub.versionOrDirtyLevel;

			if (subDirtyLevel < dirtyLevel) {
				sub.versionOrDirtyLevel = dirtyLevel;
			}

			if (subDirtyLevel === DirtyLevels.None) {

				if ('notify' in sub) {
					const queuedEffectsTail = system.queuedEffectsTail;

					if (queuedEffectsTail !== undefined) {
						queuedEffectsTail.nextNotify = sub;
						system.queuedEffectsTail = sub;
					} else {
						system.queuedEffectsTail = sub;
						system.queuedEffects = sub;
					}
				} else if ('subs' in sub) {
					const subSubs = sub.subs;

					if (subSubs !== undefined) {
						lastSubs.queuedPropagateOrNextReleased = subSubs;
						lastSubs = subSubs;
						remainingQuantity++;
					}
				}
			}

			const nextSub = link.nextSub;
			if (nextSub === undefined) {
				if (remainingQuantity > 0) {
					const nextPropagate = subsHead.queuedPropagateOrNextReleased!;
					subsHead.queuedPropagateOrNextReleased = undefined;
					subsHead = nextPropagate;
					link = subsHead;

					dirtyLevel = DirtyLevels.MaybeDirty;
					remainingQuantity--;
					continue;
				}
				break;
			}

			link = nextSub;
		}
	}
}

export namespace Subscriber {

	const system = System;

	export function runInnerEffects(sub: Subscriber) {
		let link = sub.deps as Link | undefined;
		while (link !== undefined) {
			const dep = link.dep as Dependency | Dependency & IEffect;
			if ('notify' in dep) {
				dep.notify();
			}
			link = link.nextDep;
		}
	}

	/**
	 * @example Original
		export function resolveMaybeDirty(sub: Subscriber) {
			let link = sub.deps;

			while (link !== undefined) {
				const dep = link.dep as Dependency | Dependency & Subscriber;
				if ('deps' in dep) {
					if (dep.versionOrDirtyLevel === DirtyLevels.MaybeDirty) {
						resolveMaybeDirty(dep);
					}
					if (dep.versionOrDirtyLevel === DirtyLevels.Dirty && 'update' in dep) {
						dep.update!();
						if ((sub.versionOrDirtyLevel as DirtyLevels) === DirtyLevels.Dirty) {
							break;
						}
					}
				}
				link = link.nextDep;
			}

			if (sub.versionOrDirtyLevel === DirtyLevels.MaybeDirty) {
				sub.versionOrDirtyLevel = DirtyLevels.None;
			}
		}
	 */
	export function resolveMaybeDirty(sub: Subscriber) {
		let link = sub.deps;
		let depth = 0;

		while (true) {

			if (link !== undefined) {
				const dep = link.dep as Dependency | Dependency & Subscriber;

				if ('deps' in dep) {
					const depDirtyLevel = dep.versionOrDirtyLevel;

					if (depDirtyLevel === DirtyLevels.MaybeDirty) {
						dep.subs!.prevSubOrUpdate = link;
						sub = dep;
						link = dep.deps;
						depth++;

						continue;
					} else if (depDirtyLevel === DirtyLevels.Dirty && 'update' in dep) {
						dep.update!();

						if ((sub.versionOrDirtyLevel as DirtyLevels) === DirtyLevels.Dirty) {
							if (depth > 0) {
								const subSubs = (sub as Dependency & Subscriber).subs!;
								const prevLink = subSubs.prevSubOrUpdate!;
								(sub as Dependency & Subscriber).update!();
								subSubs.prevSubOrUpdate = undefined;
								sub = prevLink.sub;
								link = prevLink.nextDep;
								depth--;
								continue;
							}

							break;
						}
					}
				}

				link = link.nextDep;
				continue;
			}

			const dirtyLevel = sub.versionOrDirtyLevel;

			if (dirtyLevel === DirtyLevels.MaybeDirty) {
				sub.versionOrDirtyLevel = DirtyLevels.None;
				if (depth > 0) {
					const subSubs = (sub as Dependency & Subscriber).subs!;
					const prevLink = subSubs.prevSubOrUpdate!;
					subSubs.prevSubOrUpdate = undefined;
					sub = prevLink.sub;
					link = prevLink.nextDep;
					depth--;
					continue;
				}
			} else if (depth > 0) {
				const subSubs = (sub as Dependency & Subscriber).subs!;
				const prevLink = subSubs.prevSubOrUpdate!;
				if (dirtyLevel === DirtyLevels.Dirty) {
					(sub as Dependency & Subscriber).update!();
				}
				subSubs.prevSubOrUpdate = undefined;
				sub = prevLink.sub;
				link = prevLink.nextDep;
				depth--;
				continue;
			}

			break;
		}
	}

	export function startTrackDeps(sub: Subscriber) {
		const prevSub = system.activeDepsSub;
		system.activeDepsSub = sub;
		system.activeDepsSubsDepth++;

		sub.depsTail = undefined;
		sub.versionOrDirtyLevel = system.lastSubVersion++;

		return prevSub;
	}

	export function endTrackDeps(sub: Subscriber, prevSub: Subscriber | undefined) {
		system.activeDepsSubsDepth--;
		system.activeDepsSub = prevSub;

		const depsTail = sub.depsTail;
		if (depsTail !== undefined) {
			if (depsTail.nextDep !== undefined) {
				clearTrack(depsTail.nextDep);
				depsTail.nextDep = undefined;
			}
		} else if (sub.deps !== undefined) {
			clearTrack(sub.deps);
			sub.deps = undefined;
		}
		sub.versionOrDirtyLevel = DirtyLevels.None;
	}

	export function clearTrack(link: Link | undefined) {
		while (link !== undefined) {

			const nextDep = link.nextDep;
			const dep = link.dep as Dependency & Subscriber;
			const nextSub = link.nextSub;
			const prevSub = link.prevSubOrUpdate;

			if (nextSub !== undefined) {
				nextSub.prevSubOrUpdate = prevSub;
			}
			if (prevSub !== undefined) {
				prevSub.nextSub = nextSub;
			}

			if (nextSub === undefined) {
				link.dep.subsTail = prevSub;
			}
			if (prevSub === undefined) {
				link.dep.subs = nextSub;
			}

			// @ts-ignore
			link.dep = undefined;
			// @ts-ignore
			link.sub = undefined;
			link.prevSubOrUpdate = undefined;
			link.nextSub = undefined;
			link.nextDep = undefined;

			link.queuedPropagateOrNextReleased = Link.pool;
			Link.pool = link;

			if (dep.subs === undefined && dep.deps !== undefined) {
				link = dep.deps;
				dep.depsTail!.nextDep = nextDep;
				dep.deps = undefined;
				dep.depsTail = undefined;
				dep.versionOrDirtyLevel = DirtyLevels.Released;
				continue;
			}

			link = nextDep;
		}
	}

	export function startTrackEffects(sub: Subscriber) {
		const prevSub = system.activeEffectsSub;
		system.activeEffectsSub = sub;
		system.activeEffectsSubsDepth++;

		sub.depsTail = undefined;
		sub.versionOrDirtyLevel = system.lastSubVersion++;

		return prevSub;
	}

	export function endTrackEffects(sub: Subscriber, prevSub: Subscriber | undefined) {
		system.activeEffectsSubsDepth--;
		system.activeEffectsSub = prevSub;

		const depsTail = sub.depsTail;
		if (depsTail !== undefined) {
			if (depsTail.nextDep !== undefined) {
				clearTrack(depsTail.nextDep);
				depsTail.nextDep = undefined;
			}
		} else if (sub.deps !== undefined) {
			clearTrack(sub.deps);
			sub.deps = undefined;
		}
		sub.versionOrDirtyLevel = DirtyLevels.None;
	}
}
