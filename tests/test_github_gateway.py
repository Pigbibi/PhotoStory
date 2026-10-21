"""The public native wire protocol; all HTTPS and credentials are fake."""
import io
import json
import os
from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import github_gateway as gateway

class Reply(io.BytesIO):
    def __init__(self,body=b'{}',status=200,headers=None):
        super().__init__(body);self.status,self.headers=status,headers or {}

class GatewayTests(unittest.TestCase):
    def client(self,opener=None,token=None):
        return gateway.NativeTaskClient('https://personal.invalid','https://personal.invalid/mcp',
                                        opener=opener or Mock(),token=token or (lambda:'synthetic-token'))

    def test_three_methods_preserve_wire_identity_without_poll_or_retry(self):
        opener=Mock();opener.open.side_effect=[Reply(status=202),Reply(),Reply()]
        client=self.client(opener);request={'mode':'agent','timeout_seconds':60,'objective':'generated only'}
        client.submit(request,'photostory:same-operation');client.get('same-task');client.cancel('same-task')
        sent=[c.args[0] for c in opener.open.call_args_list]
        self.assertEqual([(r.method,r.full_url) for r in sent],[
            ('POST','https://personal.invalid/v1/tasks'),('GET','https://personal.invalid/v1/tasks/same-task'),
            ('POST','https://personal.invalid/v1/tasks/same-task/cancel')])
        self.assertEqual(json.loads(sent[0].data),request)
        self.assertEqual(sent[0].get_header('Idempotency-key'),'photostory:same-operation')
        self.assertIsNone(sent[1].data);self.assertEqual(json.loads(sent[2].data),{})
        self.assertTrue(all(r.get_header('Authorization')=='Bearer synthetic-token' for r in sent))
        self.assertTrue(all(c.kwargs['timeout']<=60 for c in opener.open.call_args_list))

    def test_constructor_is_lazy_and_default_opener_blocks_redirects(self):
        token=Mock(return_value='synthetic')
        with patch.object(gateway.urllib.request,'build_opener') as build:
            client=gateway.NativeTaskClient('https://personal.invalid','https://personal.invalid/mcp',token=token)
        token.assert_not_called();self.assertEqual(client.resource,'https://personal.invalid')
        self.assertIsInstance(build.call_args.args[0],gateway.NoRedirect)
        with self.assertRaises(ValueError):build.call_args.args[0].redirect_request(None,None,302,'',{},'https://else.invalid')

    def test_oidc_replaces_audience_and_checks_original_github_origin(self):
        opener=Mock();opener.open.return_value=Reply(b'{"value":"synthetic-oidc"}')
        env={'ACTIONS_ID_TOKEN_REQUEST_URL':'https://pipelines.actions.githubusercontent.com/token?api-version=2&audience=old',
             'ACTIONS_ID_TOKEN_REQUEST_TOKEN':'synthetic-request-token'}
        with patch.dict(os.environ,env,clear=True):
            self.assertEqual(gateway.oidc_token('https://personal.invalid/mcp',opener=opener),'synthetic-oidc')
        from urllib.parse import parse_qs,urlsplit
        self.assertEqual(parse_qs(urlsplit(opener.open.call_args.args[0].full_url).query),
                         {'api-version':['2'],'audience':['https://personal.invalid/mcp']})
        for url in ['https://evil.invalid/token','http://pipelines.actions.githubusercontent.com/token',
                    'https://user@pipelines.actions.githubusercontent.com/token','https://pipelines.actions.githubusercontent.com:444/token']:
            with self.subTest(url=url),patch.dict(os.environ,{**env,'ACTIONS_ID_TOKEN_REQUEST_URL':url},clear=True):
                with self.assertRaises(ValueError):gateway.oidc_token('https://personal.invalid/mcp',opener=opener)
        self.assertEqual(opener.open.call_count,1)

    def test_invalid_inputs_stop_before_token_and_network(self):
        opener=Mock();token=Mock(return_value='synthetic')
        for url in ['http://personal.invalid','https://u:p@personal.invalid','https://personal.invalid/mcp',
                    'https://personal.invalid?token=x','https://personal.invalid/#x','https://personal.invalid\n']:
            with self.subTest(url=url),self.assertRaises(ValueError):
                gateway.NativeTaskClient(url,'https://personal.invalid/mcp',opener=opener,token=token)
        client=self.client(opener,token)
        for task in ['', '../cancel', 'x/y','x?project=other','x\n',None]:
            with self.subTest(task=task),self.assertRaises(ValueError):client.get(task)
        for key in ['', 'bad\nkey','x'*201,None]:
            with self.subTest(key=key),self.assertRaises(ValueError):client.submit({'mode':'agent','timeout_seconds':60},key)
        for seconds in [True,61,600,0]:
            with self.subTest(seconds=seconds),self.assertRaises(ValueError):client.submit({'mode':'agent','timeout_seconds':seconds},'same')
        token.assert_not_called();opener.open.assert_not_called()

    def test_two_mb_caps_and_strict_json(self):
        opener=Mock();token=Mock(return_value='synthetic');client=self.client(opener,token)
        with self.assertRaises(ValueError):client.submit({'mode':'agent','timeout_seconds':60,'objective':'x'*2_000_000},'same')
        token.assert_not_called();opener.open.assert_not_called()
        for response in [Reply(b' '*2_000_001),Reply(b'{}',headers={'Content-Length':'2000001'}),
                         Reply(b'[]'),Reply(b'{"x":NaN}'),Reply(b'{"x":1,"x":2}')]:
            opener.open.return_value=response
            with self.subTest(response=response),self.assertRaises(ValueError):client.get('same-task')

    def test_ambiguous_submit_errors_are_not_retried_or_leaked(self):
        for error in [TimeoutError('PRIVATE material'),urllib.error.HTTPError('https://personal.invalid',403,'PRIVATE',{},None),
                      urllib.error.URLError('PRIVATE token')]:
            opener=Mock();opener.open.side_effect=error;client=self.client(opener)
            with self.subTest(error=type(error)),self.assertRaises(Exception) as caught:
                client.submit({'mode':'agent','timeout_seconds':60},'same-key')
            self.assertNotIn('PRIVATE',str(caught.exception));self.assertEqual(opener.open.call_count,1)

if __name__=='__main__':unittest.main()
