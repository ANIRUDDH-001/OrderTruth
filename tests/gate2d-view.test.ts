import { describe, expect, it, vi } from 'vitest';
import { mapIncident, loadIncident, selectEntity, snapshotFor, visibleOrderIds } from '../web/investigation/model.ts';
import { syntheticIncident } from '../web/investigation/synthetic.ts';

describe('Gate2D presentation boundary', () => {
  it('keeps opening and latest distinct and both merchant identities selectable', () => {
    const v = mapIncident(syntheticIncident(), 'org_reference');
    expect(snapshotFor(v, 'detection').count).toBe(2);
    expect(snapshotFor(v, 'latest').count).toBe(1);
    expect(selectEntity(v, 'detection', 'order:demo-keeper').id).toBe('demo-keeper');
    expect(selectEntity(v, 'detection', 'order:demo-duplicate').id).toBe('demo-duplicate');
    expect(selectEntity(v, 'latest', 'order:demo-duplicate').fields).toContainEqual(['Effective status', 'voided_duplicate']);
  });
  it('does not treat latest HOLDS as incident resolution', () => {
    const r = syntheticIncident(); r.state = 'open';
    expect(mapIncident(r, 'org_reference').state).toBe('open');
  });
  it('rejects cross-org responses', () => expect(() => mapIncident(syntheticIncident(), 'org_other')).toThrow(/organization/));
  it.each([null, {}, [], { id: 1 }])('rejects malformed payload %j', raw => expect(() => mapIncident(raw, 'org_reference')).toThrow());
  it('missing provider evidence produces unavailable, never captured', () => {
    const r = syntheticIncident(); r.evidence = [];
    expect(mapIncident(r, 'org_reference').provider.title).toContain('unavailable');
  });
  it('conflicting readback cannot become a completed capture', () => {
    const r = syntheticIncident(); r.evidence[0]!.summary.captureId = 'OTHER';
    expect(mapIncident(r, 'org_reference').provider.title).toContain('unavailable');
  });
  it('conflicting readback amounts fail closed', () => {
    const r=syntheticIncident(); const other=structuredClone(r.evidence[0]!); other.seq=8;other.ref.id='8';other.summary.amount={currency:'USD',value:'99.00'};r.evidence.push(other);r.openingEvaluation.facts.confirmingReadbackSeqs.push(8);
    expect(mapIncident(r,'org_reference').provider.title).toContain('unavailable');
  });
  it('invalid provider amount never displays completed capture',()=>{
    const r=syntheticIncident();r.evidence[0]!.summary.amount={currency:'USD',value:'NaN'};
    expect(mapIncident(r,'org_reference').provider.title).toContain('unavailable');
  });
  it('accepts precise two-decimal money without floating-point rejection',()=>{
    const r=syntheticIncident();r.evidence[0]!.summary.amount={currency:'USD',value:'0.29'};
    expect(mapIncident(r,'org_reference').provider.title).toBe('Persisted completed capture');
  });
  it('local loader rejects another incident returned for the requested ID',async()=>{
    const r=syntheticIncident();r.id='inc_00000000-0000-4000-8000-000000000099';
    await expect(loadIncident({mode:'local',id:syntheticIncident().id,org:'org_reference'},vi.fn().mockResolvedValue(new Response(JSON.stringify(r))))).rejects.toThrow(/identity/);
  });
  it('missing latest evaluation remains unavailable', () => {
    const r = syntheticIncident(); r.latestEvaluation = null;
    expect(snapshotFor(mapIncident(r, 'org_reference'), 'latest').result).toBe('UNAVAILABLE');
  });
  it('receipt includes linked append-only void and incident-specific postcondition, independently of latest',()=>{
    const v=mapIncident(syntheticIncident(),'org_reference');
    expect(v.receipt.some(e=>e.id.startsWith('voids:'))).toBe(true);
    expect(v.receipt.some(e=>e.id.startsWith('resolutions:'))).toBe(true);
  });
  it('historical order status comes from opening observation, not current status', () => {
    const v = mapIncident(syntheticIncident(), 'org_reference');
    expect(selectEntity(v, 'detection', 'order:demo-duplicate').fields).toContainEqual(['Effective status', 'placed']);
  });
  it('latest diagram positions retained and voided rows by effective state rather than response order',()=>{
    const r=syntheticIncident();r.affectedOrders.reverse();
    expect(visibleOrderIds(mapIncident(r,'org_reference'),'latest')).toEqual(['demo-keeper','demo-duplicate']);
  });
  it('synthetic loader makes zero network calls', async () => {
    const f = vi.fn(); await loadIncident({ mode: 'demo' }, f);
    expect(f).not.toHaveBeenCalled();
  });
  it('local loader uses only GET and organization scope', async () => {
    const r = syntheticIncident(); const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(r)));
    await loadIncident({ mode: 'local', id: r.id, org: 'org_reference' }, f);
    expect(f).toHaveBeenCalledWith(`/api/incidents/${r.id}`, expect.objectContaining({ method: 'GET', headers: { 'x-ordertruth-org': 'org_reference' } }));
  });
  it.each([401, 404, 500])('API %i never falls back to demo', async status => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status }));
    await expect(loadIncident({ mode: 'local', id: syntheticIncident().id, org: 'org_reference' }, f)).rejects.toThrow(`HTTP ${status}`);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('rejects incomplete local configuration without request', async () => {
    const f = vi.fn(); await expect(loadIncident({ mode: 'local' }, f)).rejects.toThrow(); expect(f).not.toHaveBeenCalled();
  });
  it('latest evaluation older than opening is unavailable, not a resolution',()=>{
    const r=syntheticIncident();r.latestEvaluation!.seq=1;
    const v=mapIncident(r,'org_reference');expect(v.latest.result).toBe('UNAVAILABLE');expect(v.warnings.join(' ')).toContain('predates');
  });
  it('contradictory current rows retain an explicit stale-snapshot warning',()=>{
    const r=syntheticIncident();r.affectedOrders[1]!.effectiveStatus='placed';
    expect(mapIncident(r,'org_reference').warnings.join(' ')).toContain('disagrees');
  });
  it('contradictory HOLDS count never produces a healthy invariant',()=>{
    const r=syntheticIncident();r.latestEvaluation!.activeOrderCount=2;
    expect(mapIncident(r,'org_reference').latest.result).toBe('UNAVAILABLE');
  });
  it('missing historical snapshot does not borrow current merchant state',()=>{
    const r=syntheticIncident();r.evidence=r.evidence.filter(e=>e.ref.id!=='demo-duplicate');
    const v=mapIncident(r,'org_reference');expect(selectEntity(v,'detection','order:demo-duplicate').trust).toBe('UNVERIFIED');
  });
  it('network timeout stays an error with one request and no fallback',async()=>{
    const f=vi.fn().mockRejectedValue(new DOMException('Timed out','TimeoutError'));
    await expect(loadIncident({mode:'local',id:syntheticIncident().id,org:'org_reference'},f)).rejects.toThrow('Timed out');expect(f).toHaveBeenCalledTimes(1);
  });
});
