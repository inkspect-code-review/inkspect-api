import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewCost } from "../../src/review-cost";
import { usageReceipt, type HostConfig } from "../../src/engine-contract";
const host = { model_id: 'global.openai.gpt-6.1-sol', model_region: 'eu-west-2', input_nano_usd: 4000, output_nano_usd: 15000, model_max_output_tokens:4096, timeout_seconds:300, budget_nano_usd:5000000000, model_input_allowance:294880, model_max_request_bytes:1000000, sandbox:{},
  retrieval: { embed_model: 'eu.cohere.embed-v4:0', region: 'eu-west-2', rerank_model: 'cohere.rerank-v3-5:0', rerank_region: 'eu-central-1' } } as HostConfig;
const model = [{kind:'model.started',id:1},{kind:'model.usage',id:1,input_tokens:5780,cache_write_input_tokens:5778,cached_input_tokens:0,output_tokens:1020}];
test('replays actual Sol usage at provider prices, separate from admission/customer accounting', () => {
  const receipt = usageReceipt(model, host);
  assert.equal(receipt.provider_cost.total_nano_usd, '24649000');
  assert.equal(receipt.charged_nano_usd, '38420000');
});
test('model, embedding and billed rerank units sum once; raw header receipt is not another call', () => {
  const events = [...model, {kind:'embedding.started',id:2}, {kind:'embedding.response',id:2,http_status:200,input_tokens:9},
    {kind:'embedding.usage',id:2,http_status:200,input_tokens:9}, {kind:'rerank.started',id:3,units:7}, {kind:'rerank.usage',id:3,http_status:200,search_units:1}];
  const cost = reviewCost(events,host);
  assert.equal(cost.total_nano_usd,'26650080'); assert.equal(cost.calls.length,3);
  assert.equal(cost.components[1].cost_nano_usd,'1080');
});
test('native Bedrock rerank without billed units is a minimum estimate, never exact total', () => {
  const cost=reviewCost([...model,{kind:'rerank.started',id:2,units:7},{kind:'rerank.usage',id:2,http_status:200}],host);
  assert.equal(cost.complete,false); assert.equal(cost.total_nano_usd,null);
  assert.equal(cost.measured_nano_usd,'24649000'); assert.equal(cost.estimated_nano_usd,'2000000');
  assert.equal(cost.calls[1].search_units,undefined);
});
test('failed/ambiguous calls survive alongside successful retries and cannot become free', () => {
  const cost=reviewCost([{kind:'embedding.started',id:1},{kind:'embedding.failed',id:1,http_status:429},
    {kind:'embedding.started',id:2},{kind:'embedding.usage',id:2,http_status:200,input_tokens:10}],host);
  assert.equal(cost.total_nano_usd,null); assert.equal(cost.unmeasured_calls,1); assert.equal(cost.measured_nano_usd,'1200');
});
test('cache reads and the long-context boundary use distinct rates for the whole call', () => {
  for(const [input,expected] of [[272000,'543998000'],[272001,'1088000000']]) {
    const c=reviewCost([{kind:'model.started'},{kind:'model.usage',input_tokens:input,output_tokens:0,cached_input_tokens:5,cache_write_input_tokens:15}],host);
    assert.equal(c.total_nano_usd,String(expected));
  }
});
test('missing cache split, unknown model, duplicate usage and absent journal never claim exact costs', () => {
  assert.equal(reviewCost([],host).complete,false);
  assert.equal(reviewCost([{kind:'model.started'},{kind:'model.usage',input_tokens:5780,output_tokens:1020}],host).total_nano_usd,null);
  assert.equal(reviewCost([...model,model[1]],host).total_nano_usd,null);
  assert.equal(reviewCost([...model,model[0]],host).total_nano_usd,null);
  assert.equal(reviewCost(model,{...host,model_id:'new-model'}).total_nano_usd,null);
});
