import { v4 as uuidv4 } from 'uuid';
import { Service } from './processService.model';

const generateId = (): string => uuidv4().split('-')[0];

const createService = (service: Omit<Service, 'id'>): Service => ({
  ...service,
  id: generateId(),
});

export default createService;
