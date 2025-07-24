export const conductorLabels = ['unique_id', 'versiontag', 'type'] as const;

export type ConductorLabels = (typeof conductorLabels)[number];
