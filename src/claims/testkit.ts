import { Store } from '../db/store.ts';
import { newId, nowIso } from '../domain/ids.ts';
import {
  cents, type Charge, type ChargeId, type Coverage, type CoverageId, type Diagnosis, type Encounter, type EncounterId, type IsoDate, type IsoDateTime,
  type Patient, type PatientId,
} from '../domain/types.ts';
import type { BillingProviderConfig } from './config.ts';

export const BILLING_NPI = '1234567893';
export const RENDERING_NPI = '1987654328';

export const cfg: BillingProviderConfig = {
  name: 'Kinetik Medical Group', npi: BILLING_NPI, taxId: '123456789', taxonomyCode: '207Q00000X',
  address: { line1: '1 Main St', city: 'Kansas City', state: 'MO', zip: '64105' },
  submitterId: 'KINETIK01', submitterName: 'Kinetik Billing', contactName: 'Billing Office', contactPhone: '8165550100',
  receiverId: 'CLEARHOUSE', receiverName: 'Clearinghouse',
};

export interface Seeded {
  store: Store;
  patientId: PatientId;
  encounterId: EncounterId;
  coverage: Coverage;
}

export const seed = (opts: { patient?: Partial<Patient>; encounter?: Partial<Encounter>; coverage?: Partial<Coverage>; diagnoses?: string[] } = {}): Seeded => {
  const store = new Store(':memory:');
  const patientId = newId<PatientId>();
  store.savePatient({
    id: patientId, mrn: { value: 'MRN1', assigningAuthority: 'CERNER', typeCode: 'MR' }, lastName: 'Doe', firstName: 'Jane', middleName: 'Q',
    dob: '1980-02-03' as IsoDate, sex: 'F', address: { line1: '9 Elm St', city: 'Lenexa', state: 'KS', zip: '66215' }, updatedAt: nowIso(),
    ...opts.patient,
  });
  const encounterId = newId<EncounterId>();
  store.saveEncounter({
    id: encounterId, patientId, accountNumber: 'FIN000123', facility: 'HOSP', patientClass: 'O',
    admitAt: '2026-10-01T08:00:00Z' as IsoDateTime, dischargeAt: '2026-10-03T17:00:00Z' as IsoDateTime, updatedAt: nowIso(),
    ...opts.encounter,
  });
  const [coverage] = store.replaceCoverages(encounterId, [{
    id: newId<CoverageId>(), encounterId, priority: 1, payerId: '60054', payerName: 'Aetna', memberId: 'W123456789', groupNumber: 'GRP42',
    relationship: 'self', subscriber: { lastName: 'Doe', firstName: 'Jane', middleName: 'Q' }, ...opts.coverage,
  }]);
  const diagnoses: Diagnosis[] = (opts.diagnoses ?? ['E11.9', 'I10']).map((code, i) => ({ encounterId, sequence: i + 1, code, codingSystem: 'ICD10', type: 'F' }));
  store.replaceDiagnoses(encounterId, diagnoses);
  return { store, patientId, encounterId, coverage: coverage! };
};

let externalSeq = 0;
export const addCharge = (s: Seeded, overrides: Partial<Charge> = {}): Charge => {
  const charge: Charge = {
    id: newId<ChargeId>(), encounterId: s.encounterId, externalId: `T${++externalSeq}`, transactionType: 'CG', serviceDate: '2026-10-02' as IsoDate,
    codeSystem: 'CPT', code: '99213', modifiers: [], units: 1, amount: cents(12550),
    performingProvider: { lastName: 'Smith', firstName: 'Ann', npi: RENDERING_NPI }, diagnosisPointers: [1], status: 'unbilled',
    ...overrides,
  };
  s.store.saveCharge(charge);
  return charge;
};

/** Hand-written 835: two CLPs, CAS at claim and service level, CRLF after each segment. */
export const SAMPLE_835 = [
  'ISA*00*          *00*          *ZZ*AETNA          *ZZ*KINETIK01      *261101*1200*^*00501*000000101*0*P*:~',
  'GS*HP*AETNA*KINETIK01*20261101*1200*101*X*005010X221A1~',
  'ST*835*0001~',
  'BPR*I*130.00*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999988880*DA*98765*20261103~',
  'TRN*1*EFT0042*1512345678~',
  'N1*PR*AETNA~',
  'LX*1~',
  'CLP*FIN000123-1*1*155.50*100.00*25.00*12*PCN001*11*1~',
  'CAS*CO*45*30.00~',
  'NM1*QC*1*DOE*JANE****MI*W123456789~',
  'SVC*HC:99213*125.50*80.00**1~',
  'DTM*472*20261002~',
  'CAS*PR*2*20.00**3*5.00~',
  'SVC*HC:36415*30.00*20.00**1~',
  'CAS*OA*23*.50~',
  'CLP*FIN000456-1*4*80.00*0**12*PCN002~',
  'CAS*CO*29*50.00*1*45*30~',
  'SE*16*0001~',
  'GE*1*101~',
  'IEA*1*000000101~',
].join('\r\n') + '\r\n';
