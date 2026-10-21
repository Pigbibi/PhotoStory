"""Keep existing domain tests focused on their validators, with no legacy transport."""
from pathlib import Path
import tempfile
from unittest.mock import MagicMock, patch
from native_tasks import STAGES


def install_domain_native_entry(test, module):
    tmp = tempfile.TemporaryDirectory(prefix='photo-domain-test-')
    test.addCleanup(tmp.cleanup)
    root = Path(tmp.name).resolve()
    state = root/'state'
    state.mkdir(mode=0o700)
    client = MagicMock()
    client.resource = 'https://domain.invalid'
    context = {'synthetic_only':True, 'project':'Pigbibi/PhotoStory', 'operation_id':'domain-test',
               'fixture_root':root, 'state_root':state, 'client':client, 'persist':lambda:None,
               'deadline':2000.0,'now':lambda:1000.0,
               'routes':{s:{'mode':'agent','provider':'dot','profile':s,'model':'synthetic','worker':'synthetic-'+s} for s in STAGES}}
    original = module.run
    def run(**kwargs):
        return original(native_context=context, **kwargs)
    for target, value in [('run',run), ('native_review_gateway',lambda context,stage:module.gateway)]:
        handle = patch.object(module,target,side_effect=value)
        handle.start()
        test.addCleanup(handle.stop)
