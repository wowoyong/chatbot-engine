import { GgufModel } from '../gguf/model.js';
import type { Hyperparams } from '../gguf/model.js';
import { attention } from './attention.js';
import { linear, rmsNorm, silu } from './kernels.js';
import { applyRope } from './rope.js';

interface LayerWeights {
  attnNorm: Float32Array;
  qW: Float32Array;
  qB: Float32Array;
  kW: Float32Array;
  kB: Float32Array;
  vW: Float32Array;
  vB: Float32Array;
  oW: Float32Array;
  ffnNorm: Float32Array;
  gateW: Float32Array;
  upW: Float32Array;
  downW: Float32Array;
}

export class TransformerModel {
  private readonly hp: Hyperparams;
  private readonly tokenEmbd: Float32Array;
  private readonly outputNorm: Float32Array;
  private readonly layers: LayerWeights[];
  private readonly kCache: Float32Array[];
  private readonly vCache: Float32Array[];
  private readonly maxSeq: number;

  constructor(model: GgufModel, maxSeq = 2048) {
    this.hp = model.hyperparams();
    this.maxSeq = maxSeq;
    this.tokenEmbd = model.getTensor('token_embd.weight').data;
    this.outputNorm = model.getTensor('output_norm.weight').data;
    this.layers = [];
    for (let l = 0; l < this.hp.nLayers; l += 1) {
      this.layers.push({
        attnNorm: model.getTensor(`blk.${l}.attn_norm.weight`).data,
        qW: model.getTensor(`blk.${l}.attn_q.weight`).data,
        qB: model.getTensor(`blk.${l}.attn_q.bias`).data,
        kW: model.getTensor(`blk.${l}.attn_k.weight`).data,
        kB: model.getTensor(`blk.${l}.attn_k.bias`).data,
        vW: model.getTensor(`blk.${l}.attn_v.weight`).data,
        vB: model.getTensor(`blk.${l}.attn_v.bias`).data,
        oW: model.getTensor(`blk.${l}.attn_output.weight`).data,
        ffnNorm: model.getTensor(`blk.${l}.ffn_norm.weight`).data,
        gateW: model.getTensor(`blk.${l}.ffn_gate.weight`).data,
        upW: model.getTensor(`blk.${l}.ffn_up.weight`).data,
        downW: model.getTensor(`blk.${l}.ffn_down.weight`).data,
      });
    }
    const kvDim = this.hp.nKvHeads * this.hp.headDim;
    this.kCache = this.layers.map(() => new Float32Array(maxSeq * kvDim));
    this.vCache = this.layers.map(() => new Float32Array(maxSeq * kvDim));
  }

  get hyperparams(): Hyperparams {
    return this.hp;
  }

  /** 위치 pos의 토큰 tokenId를 처리해 다음 토큰 logits[vocab] 반환. KV 캐시에 기록 */
  forward(tokenId: number, pos: number): Float32Array {
    const hp = this.hp;
    const hidden = hp.hiddenSize;
    const qDim = hp.nHeads * hp.headDim;
    const kvDim = hp.nKvHeads * hp.headDim;
    if (pos >= this.maxSeq) {
      throw new Error(`위치 ${pos}가 maxSeq ${this.maxSeq} 초과`);
    }
    const x = this.tokenEmbd.slice(tokenId * hidden, tokenId * hidden + hidden);

    for (let l = 0; l < this.layers.length; l += 1) {
      const L = this.layers[l]!;
      const h = rmsNorm(x, L.attnNorm, hp.rmsEps);
      const q = linear(L.qW, h, hidden, qDim, L.qB);
      const k = linear(L.kW, h, hidden, kvDim, L.kB);
      const v = linear(L.vW, h, hidden, kvDim, L.vB);
      applyRope(q, pos, hp.nHeads, hp.headDim, hp.ropeFreqBase);
      applyRope(k, pos, hp.nKvHeads, hp.headDim, hp.ropeFreqBase);
      this.kCache[l]!.set(k, pos * kvDim);
      this.vCache[l]!.set(v, pos * kvDim);
      const attnOut = attention(
        q,
        this.kCache[l]!,
        this.vCache[l]!,
        pos,
        hp.nHeads,
        hp.nKvHeads,
        hp.headDim,
      );
      const o = linear(L.oW, attnOut, qDim, hidden);
      for (let i = 0; i < hidden; i += 1) {
        x[i]! += o[i]!;
      }
      const h2 = rmsNorm(x, L.ffnNorm, hp.rmsEps);
      const gate = linear(L.gateW, h2, hidden, hp.ffnSize);
      const up = linear(L.upW, h2, hidden, hp.ffnSize);
      for (let i = 0; i < hp.ffnSize; i += 1) {
        gate[i] = silu(gate[i]!) * up[i]!;
      }
      const down = linear(L.downW, gate, hp.ffnSize, hidden);
      for (let i = 0; i < hidden; i += 1) {
        x[i]! += down[i]!;
      }
    }

    const normed = rmsNorm(x, this.outputNorm, hp.rmsEps);
    const logits = new Float32Array(hp.vocabSize);
    for (let t = 0; t < hp.vocabSize; t += 1) {
      const base = t * hidden;
      let dot = 0;
      for (let d = 0; d < hidden; d += 1) {
        dot += normed[d]! * this.tokenEmbd[base + d]!;
      }
      logits[t] = dot;
    }
    return logits;
  }
}
