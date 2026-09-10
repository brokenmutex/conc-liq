import contextlib,hashlib,importlib.util,io,json,pathlib,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('hours',ROOT/'scripts/analyze-lp-hours.py')
hours=importlib.util.module_from_spec(spec);spec.loader.exec_module(hours)

class HoursAnalysisTests(unittest.TestCase):
 def test_calendar_holidays_session_edges_and_dst(self):hours.check_calendar()
 def run_fixture(self,frames,complete=False):
  with tempfile.TemporaryDirectory() as temp:
   p=pathlib.Path(temp);source=p/'source.json';raw=json.dumps({'manifest':{'canonical':True},'frames':frames}).encode();source.write_bytes(raw)
   (p/'source.json.sha256').write_text(hashlib.sha256(raw).hexdigest());(p/'paper.json').write_text('{"sessions":[],"selectedIds":[]}')
   with contextlib.redirect_stdout(io.StringIO()):hours.analyze(source,p/'paper.json',p/'out',complete)
   return json.loads((p/'out/hours-summary.json').read_text())
 def frames(self,gap=False):
  # The price returns to its starting point. Only intra-window events reveal
  # the 25-tick excursion; it must not disappear in a zero endpoint return.
  start=hours.timestamp('2026-09-09T01:00:00Z');frames=[]
  for minute in ([0,15,30] if gap else range(31)):
   frames.append({'id':str(minute),'sourceAt':(start+hours.dt.timedelta(minutes=minute)).isoformat(),'tick':0,'price':'1000000',
    'events':[{'name':'Swap','args':{'tick':25,'amount0':'1000000'}},{'name':'Swap','args':{'tick':0,'amount0':'-1000000'}}] if minute==15 else []})
  return frames
 def test_reversal_crosses_range_despite_unchanged_endpoint(self):
  a=self.run_fixture(self.frames())['aggregates'][0]
  self.assertEqual(a['n'],1);self.assertEqual(a['absoluteReturnPct']['max'],0)
  self.assertEqual(a['peakExcursionTicks']['max'],25);self.assertEqual(a['crossingPct']['20'],100)
  self.assertEqual(a['crossingPct']['30'],0)
 def test_checkpoint_gap_sensitivity_is_explicit(self):
  strict=self.run_fixture(self.frames(True));complete=self.run_fixture(self.frames(True),True)
  self.assertEqual(strict['aggregates'],[]);self.assertEqual(complete['aggregates'][0]['peakExcursionTicks']['max'],25)
 def test_session_transition_excluded(self):
  f=self.frames();start=hours.timestamp('2026-09-09T13:20:00Z')
  for row in f:row['sourceAt']=(start+hours.dt.timedelta(minutes=int(row['id']))).isoformat()
  self.assertEqual(self.run_fixture(f)['aggregates'],[])

if __name__=='__main__':unittest.main()
