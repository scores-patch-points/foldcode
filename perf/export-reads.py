import sqlite3,json,datetime
db=sqlite3.connect('file:/Users/mlacy/.local/share/opencode/opencode.db?mode=ro',uri=True)
since=int(datetime.datetime(2026,9,15).timestamp()*1000)
sess=db.execute("select id,title from session where time_created>=? and title not like '%subagent%'",(since,)).fetchall()
out=[]
for sid,title in sess:
    msgs=db.execute("select id,data,time_created from message where session_id=? order by time_created,id",(sid,)).fetchall()
    role={m[0]:json.loads(m[1]).get('role') for m in msgs}
    parts=collections=None
    byMsg={}
    for pid,mid,d in db.execute("select id,message_id,data from part where session_id=? order by time_created,id",(sid,)):
        try:j=json.loads(d)
        except: continue
        byMsg.setdefault(mid,[]).append(j)
    turns=[];ask=""
    for mid,_,_ in msgs:
        if role.get(mid)=='user':
            ask=" ".join(p.get('text','') for p in byMsg.get(mid,[]) if p.get('type')=='text')[:400]
        elif role.get(mid)=='assistant':
            reads=[]
            for p in byMsg.get(mid,[]):
                if p.get('type')=='tool' and p.get('tool')=='read':
                    inp=(p.get('state') or {}).get('input') or {}
                    fp=inp.get('filePath') or inp.get('path')
                    if fp: reads.append(fp)
            turns.append({"ask":ask,"reads":reads})
    nreads=sum(len(t['reads']) for t in turns)
    if len(turns)>=25 and nreads>=15: out.append({"sid":sid[-8:],"title":title[:50],"turns":turns})
out.sort(key=lambda s:-sum(len(t['reads']) for t in s['turns']))
json.dump(out[:80],open('reads.json','w'))
print(len(out),"sessions kept;",sum(len(s['turns']) for s in out[:80]),"turns;",sum(len(t['reads']) for s in out[:80] for t in s['turns']),"reads")
