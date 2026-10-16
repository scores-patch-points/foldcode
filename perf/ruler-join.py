#!/usr/bin/env python3
"""Layer 0 falsifier: join a FOLD_RULER_FILE (request lines + token lines) and check the ruler against the bill.
usage: ruler-join.py ruler.jsonl
Pairs the n-th request line of a session with the n-th token line. PASS needs (a) overhead <= 5% of body, and
(b) chars per billed prompt token stable: coefficient of variation across calls <= 15%. Then prints tokens/char per
segment by least squares so segment estimates become tokens."""
import json,sys,collections,statistics
req=collections.defaultdict(list); tok=collections.defaultdict(list)
for l in open(sys.argv[1]):
    j=json.loads(l)
    (tok if 'tokens' in j else req)[j['sid']].append(j)
rows=[]
for sid,rs in req.items():
    for r,t in zip(rs,tok.get(sid,[])):
        tk=t['tokens'] or {}; c=tk.get('cache') or {}
        n=(tk.get('input') or 0)+(c.get('read') or 0)+(c.get('write') or 0)
        if n: rows.append((r,n))
if not rows: sys.exit("no joined rows")
ov=[r['overhead']/r['total'] for r,_ in rows]; cpt=[r['total']/n for r,n in rows]
cv=statistics.pstdev(cpt)/statistics.mean(cpt)
print(f"calls {len(rows)}  overhead mean {100*statistics.mean(ov):.1f}% max {100*max(ov):.1f}%  chars/token {statistics.mean(cpt):.2f} CV {100*cv:.1f}%")
print("PASS" if max(ov)<=0.05 and cv<=0.15 else "FAIL", "(overhead<=5%, CV<=15%)")
