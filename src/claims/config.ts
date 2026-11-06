import type { Address } from '../domain/types.ts';

export interface BillingProviderConfig {
  name: string;
  npi: string;
  taxId: string;
  taxonomyCode: string;
  address: Address;
  submitterId: string;
  submitterName: string;
  contactName: string;
  contactPhone: string;
  receiverId: string;
  receiverName: string;
}
