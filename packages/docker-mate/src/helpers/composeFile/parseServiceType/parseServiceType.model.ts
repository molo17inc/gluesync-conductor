import { ConductorServiceTypes } from '../../../models/conductor.model';

export type ParseServiceType = (type: any) => ConductorServiceTypes | null;
