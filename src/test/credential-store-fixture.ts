export interface TestCredentialStore {
  deletePassword: (service: string, account: string) => Promise<boolean>;
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (
    service: string,
    account: string,
    password: string
  ) => Promise<void>;
}

export function createCredentialStoreFixture() {
  const entries = new Map<string, string>();
  const events: string[] = [];
  const failures: {
    delete?: Error;
    get?: Error;
    set?: Error;
  } = {};
  const controls: {
    setFailureAfterWrite?: Error;
    verification?: { value: string | null };
    verificationValues?: (string | null)[];
  } = {};
  let writeOccurred = false;
  let loadCount = 0;

  const entryKey = (service: string, account: string) =>
    `${service}\u0000${account}`;
  const store: TestCredentialStore = {
    deletePassword(service, account) {
      events.push("local:delete");
      if (failures.delete) {
        return Promise.reject(failures.delete);
      }
      return Promise.resolve(entries.delete(entryKey(service, account)));
    },
    getPassword(service, account) {
      events.push("local:get");
      if (failures.get) {
        return Promise.reject(failures.get);
      }
      if (writeOccurred && controls.verificationValues?.length) {
        return Promise.resolve(controls.verificationValues.shift() ?? null);
      }
      if (writeOccurred && controls.verification) {
        const { value } = controls.verification;
        controls.verification = undefined;
        return Promise.resolve(value);
      }
      return Promise.resolve(entries.get(entryKey(service, account)) ?? null);
    },
    setPassword(service, account, password) {
      events.push("local:set");
      if (failures.set) {
        return Promise.reject(failures.set);
      }
      entries.set(entryKey(service, account), password);
      writeOccurred = true;
      if (controls.setFailureAfterWrite) {
        const error = controls.setFailureAfterWrite;
        controls.setFailureAfterWrite = undefined;
        return Promise.reject(error);
      }
      return Promise.resolve();
    },
  };

  return {
    entries,
    events,
    failures,
    controls,
    getEntry: (service: string, account: string) =>
      entries.get(entryKey(service, account)) ?? null,
    get loadCount() {
      return loadCount;
    },
    loader: () => {
      loadCount += 1;
      return Promise.resolve(store);
    },
    seed: (service: string, account: string, password: string) => {
      entries.set(entryKey(service, account), password);
    },
    store,
  };
}
