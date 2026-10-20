# app-murakumo: itonami dapp bundle 化の要否判定

判定日: 2026-10-20。追跡: Linear JUN-128（親 JUN-116）。

## 結論: **bundle 化不要**（残る候補は将来再検討）

## 根拠

1. **murakumo は判定を実行する場そのもの**（RunPod GPU + vLLM + LiteLLM +
   CF Worker gateway = 全 fleet の server-side 推論インフラ、ADR-2605010000）。
   itonami の bundle は「判定コアを host で実行する」形であり、推論 rung
   自体を載せると **判定の実行場を判定対象にする**ことになる。
2. **判定すべき境界は既に各 app に着地済み**:
   - app-browser の `llm-admission`（HTTP POST capability 明示必須 +
     **Murakumo のみ** = ADR-2605215000）
   - app-kg-curator の `inference-ok`（**on-prem のみ**、外部 AI は違反）
   「外部 AI に飛ばさない」判定は使われる側に固定されており、murakumo 側の
   bundle は重複になる。
3. **残る判定の候補**（将来 bundle 化するなら）:
   - **auth 層**: sk_live_* / `mkc_*` ephemeral HMAC（**1h TTL**、匿名 chat）/
     break-glass —— comfyui の auth-admission と同族。
   - **model affinity 規則**（`tokenizer.apply_chat_template` 必須）。

## 運用上の境界（docs 記録）

- ブラウザ訪問者の匿名 chat は `mkc_*`（MURAKUMO_CHAT_SECRET、1h TTL）。
- Mac Mini fleet は L8 Somatic Inference（resident organism actors 専用、
  ADR-2605080600）。
