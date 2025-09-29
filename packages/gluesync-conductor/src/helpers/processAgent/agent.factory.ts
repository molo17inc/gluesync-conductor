import { v4 as uuidv4 } from 'uuid';
import { Agent } from './processAgent.model';

const generateId = (): string => uuidv4().split('-')[0];

export const createAgent = (agent: Omit<Agent, 'id'>): Agent => ({
  ...agent,
  id: generateId(),
});
