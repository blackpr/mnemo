import type { DomainEvent, EpisodeId, FactId, ModelRef } from "../../shared-kernel/index.js";
import type { InvalidationReason } from "./fact.js";

export type EpisodeRecorded = DomainEvent<"memory.EpisodeRecorded", { readonly episodeId: EpisodeId; readonly source: string }>;

export type FactAsserted = DomainEvent<
  "memory.FactAsserted",
  { readonly factId: FactId; readonly sourceEpisodeIds: readonly EpisodeId[]; readonly extractor?: ModelRef }
>;

export type FactSuperseded = DomainEvent<"memory.FactSuperseded", { readonly oldFactId: FactId; readonly newFactId: FactId }>;

export type FactInvalidated = DomainEvent<
  "memory.FactInvalidated",
  { readonly factId: FactId; readonly reason: InvalidationReason }
>;

export type FactConfirmed = DomainEvent<"memory.FactConfirmed", { readonly factId: FactId }>;
export type FactDisputed = DomainEvent<"memory.FactDisputed", { readonly factId: FactId }>;

export type MemoryEvent = EpisodeRecorded | FactAsserted | FactSuperseded | FactInvalidated | FactConfirmed | FactDisputed;
