/** Illustrative records only. No provider, database or model is contacted. */
export function syntheticIncident() {
  const id = 'inc_00000000-0000-4000-8000-000000000024';
  const at = '2026-10-19T09:41:07Z';
  const payment = { intentId: 'ci_00000000-0000-4000-8000-000000001042', attemptId: 'demo-attempt', paypalOrderId: 'DEMO-PAYMENT', captureId: 'DEMO-CAP-01' };
  const order = (id: string, path: string) => ({ id, organization_id: 'org_reference', intent_id: payment.intentId, attempt_id: payment.attemptId, paypal_order_id: payment.paypalOrderId, capture_id: payment.captureId, status: 'placed', created_by_path: path, created_at: '2026-10-19T09:41:06Z', currency: 'USD', amount_minor: 4800 });
  return {
    id, organizationId: 'org_reference', class: 'DUPLICATE_MERCHANT_ORDER', contract: 'REF_MERCHANT_ONE_CAPTURE_ONE_ORDER_V1', severity: 'high', state: 'resolved_verified', historicalState: 'open',
    title: 'One payment. Two merchant orders.', openedAt: at, payment,
    openingEvaluation: { seq: 3, result: 'VIOLATED', activeOrderCount: 2, evaluatedAt: at, facts: { matchingOrderIds: ['demo-keeper', 'demo-duplicate'], confirmingReadbackSeqs: [1] }, reasons: ['Two matching orders for the reference checkout'] },
    latestEvaluation: { seq: 5, result: 'HOLDS', activeOrderCount: 1, evaluatedAt: '2026-10-19T09:48:12Z', facts: { matchingOrderIds: ['demo-keeper'] }, reasons: ['One effective matching order'] } as Record<string, unknown> | null,
    affectedOrders: [
      { id: 'demo-keeper', status: 'placed', effectiveStatus: 'placed', createdByPath: 'capture_return', createdAt: '2026-10-19T09:41:06Z', amount: { currency: 'USD', minor: 4800 } },
      { id: 'demo-duplicate', status: 'placed', effectiveStatus: 'voided_duplicate', createdByPath: 'webhook_capture_completed', createdAt: '2026-10-19T09:41:06Z', amount: { currency: 'USD', minor: 4800 } },
    ],
    evidence: [
      { seq: 1, evidenceClass: 'PAYPAL_API_READBACK', ref: { type: 'evidence', id: '1' }, sourceAt: '2026-10-19T09:40:04Z', summary: { httpStatus: 200, orderId: payment.paypalOrderId, captureId: payment.captureId, captureStatus: 'COMPLETED', amount: { currency: 'USD', value: '48.00' } } as Record<string, unknown> },
      ...['demo-keeper', 'demo-duplicate'].map((id, n) => ({ seq: n + 2, evidenceClass: 'MERCHANT_DB_OBSERVED', ref: { type: 'merchant_order', id }, sourceAt: '2026-10-19T09:41:06Z', summary: { snapshot: order(id, n ? 'webhook_capture_completed' : 'capture_return') } as Record<string, unknown> })),
      { seq: 4, evidenceClass: 'CONTROLLED_FAULT_INJECTION', ref: { type: 'fault_injection', id: 'demo-race' }, sourceAt: '2026-10-19T09:40:05Z', summary: { kind: 'DUPLICATE_ORDER_RACE', label: 'CONTROLLED_FAULT_INJECTION' } as Record<string, unknown> },
    ],
    repairHistory: {
      identityAssurance: 'LOCAL_DEMO_DECLARED_OPERATOR', authentication: 'NONE', separationOfDutiesEnforced: false,
      plans: [{ id: 'demo-plan', incident_id: id, keep_order_id: 'demo-keeper', void_order_ids_json: '["demo-duplicate"]', created_at: '2026-10-19T09:45:00Z' }],
      approvals: [{ plan_id: 'demo-plan', operator_name: 'Illustrative operator', mode: 'SYNTHETIC_DEMO_ONLY', approved_at: '2026-10-19T09:46:02Z' }],
      executions: [{ id: 'demo-execution', execution_id: 'demo-execution', plan_id: 'demo-plan', outcome: 'SUCCEEDED', completed_at: '2026-10-19T09:48:12Z', provider_before_sha256: 'a'.repeat(64), provider_after_sha256: 'a'.repeat(64) }],
      voids: [{order_id:'demo-duplicate',execution_id:'demo-execution',reason:'DUPLICATE_MERCHANT_ORDER',created_at:'2026-10-19T09:47:18Z'}],
      resolutions: [{incident_id:id,evaluation_seq:5,execution_id:'demo-execution',created_at:'2026-10-19T09:48:12Z',postcondition:{seq:5,result:'HOLDS',activeOrderCount:1,evaluatedAt:'2026-10-19T09:48:12Z',facts:{matchingOrderIds:['demo-keeper']}}}],
      audit: [{ seq: 1, plan_id: 'demo-plan', event: 'SUCCEEDED', detail_json: '{"executionId":"demo-execution"}', created_at: '2026-10-19T09:48:12Z' }],
    },
  };
}
