import type {
  DiscoveryCandidatePage,
  StoragePort,
} from "../ports/storage-port.js";
import type { AccountBinding } from "../../domain/repository.js";

export interface CandidateQueryInput {
  readonly state: "discovered" | "selected" | "dismissed" | "starred" | null;
  readonly query: string | null;
  readonly limit: number;
  readonly cursor: string | null;
}

export class CandidateQueryService {
  readonly #storage: Pick<StoragePort, "queryDiscoveryCandidates">;
  readonly #binding: AccountBinding;

  constructor(
    storage: Pick<StoragePort, "queryDiscoveryCandidates">,
    binding: AccountBinding,
  ) {
    this.#storage = storage;
    this.#binding = Object.freeze({ ...binding });
  }

  query(input: CandidateQueryInput): DiscoveryCandidatePage {
    const query = {
      binding: this.#binding,
      pageSize: input.limit,
      cursor: input.cursor,
      ...(input.state === null ? {} : { state: input.state }),
      ...(input.query === null ? {} : { query: input.query }),
    };
    return this.#storage.queryDiscoveryCandidates(query);
  }
}
