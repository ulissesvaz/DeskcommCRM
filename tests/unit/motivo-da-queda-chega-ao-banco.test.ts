/**
 * O MOTIVO DE UMA CONEXÃO CAIR CHEGA AO BANCO — NÃO SÓ AO AVISO.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * `checkHealth` apura `detail` (ex.: `meta_100_33`, `conta_em_erro`) e
 * `avisoDaConexao` já o usava no corpo do aviso da Central — mas o `update` que
 * o cron `channel-health` faz em `channel_sessions` gravava só `status`, nunca
 * `status_reason`. Medido numa organização real: três quedas seguidas da mesma
 * conexão de Instagram, as três com `status_reason` vazio, mesmo quando o
 * provider tinha respondido com um código específico.
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * Comportamento, pelo PAYLOAD que a rota manda ao banco, nas duas direções:
 *
 *   1. a queda grava o motivo que o adapter apurou;
 *   2. a volta (`detail: null`) LIMPA o motivo antigo — senão a conexão
 *      saudável seguiria exibindo o porquê de uma queda que já passou.
 *
 * E o controle: sem conseguir perguntar (`reachable: false`), nada é gravado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO = "segredo-de-cron-do-motivo";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: SEGREDO, INTERNAL_SECRET: "" },
}));

/** O que o adapter responde nesta rodada. */
let saude: { reachable: boolean; status: string | null; detail: string | null } = {
  reachable: true,
  status: "WORKING",
  detail: null,
};

vi.mock("@/lib/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/channels")>();
  return {
    ...real,
    getAdapter: () => ({ checkHealth: async () => saude }),
  };
});

vi.mock("@/lib/channels/health", () => ({
  sincronizarSaudeDaConexao: () => Promise.resolve("sem_mudanca"),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

let linhas: Array<Record<string, unknown>> = [];
const atualizou = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "is", "eq"]) cadeia[m] = () => cadeia;
      cadeia.update = (patch: unknown) => {
        atualizou(patch);
        return cadeia;
      };
      cadeia.limit = async () => ({ data: linhas, error: null });
      return cadeia;
    },
  }),
}));

function sessao(status: string): Record<string, unknown> {
  return {
    id: "sess",
    organization_id: "org",
    status,
    display_name: null,
    phone_number: null,
    archived_at: null,
    provider: "waha",
    waha_session_name: "numero-de-verdade",
    meta_phone_number_id: null,
    zernio_account_id: null,
  };
}

async function rodar(): Promise<number> {
  const { GET } = await import("@/app/api/v1/cron/channel-health/route");
  const res = await GET({ headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never);
  return res.status;
}

beforeEach(() => {
  vi.clearAllMocks();
  linhas = [];
});

describe("o motivo da queda da conexão chega ao banco", () => {
  it("a queda grava o motivo que o adapter apurou", async () => {
    linhas = [sessao("WORKING")];
    saude = { reachable: true, status: "FAILED", detail: "meta_100_33" };
    expect(await rodar()).toBe(200);
    expect(atualizou).toHaveBeenCalledTimes(1);
    expect(atualizou.mock.calls[0]?.[0]).toMatchObject({
      status: "FAILED",
      status_reason: "meta_100_33",
    });
  });

  it("a volta limpa o motivo da queda que já passou", async () => {
    linhas = [sessao("FAILED")];
    saude = { reachable: true, status: "WORKING", detail: null };
    expect(await rodar()).toBe(200);
    expect(atualizou).toHaveBeenCalledTimes(1);
    expect(atualizou.mock.calls[0]?.[0]).toHaveProperty("status_reason", null);
  });

  it("controle: sem conseguir perguntar, nada é gravado", async () => {
    // Sem isto, os dois casos acima poderiam estar verdes por um `update` que
    // roda sempre, com ou sem resposta do provider.
    linhas = [sessao("WORKING")];
    saude = { reachable: false, status: null, detail: "timeout" };
    expect(await rodar()).toBe(200);
    expect(atualizou).not.toHaveBeenCalled();
  });
});
