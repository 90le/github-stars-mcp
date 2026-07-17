import { defineStoragePortContract } from "../../contracts/storage-port.contract.js";
import { SQLiteStore } from "../../../src/storage/sqlite-store.js";

defineStoragePortContract("SQLite", () => {
  const store = new SQLiteStore(":memory:", {
    now: () => "2026-07-16T00:00:00.000Z",
  });
  store.migrate();
  return {
    store,
    cleanup() {
      store.close();
    },
  };
});
