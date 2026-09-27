import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import json
import os
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from cloud_inventory import CloudInventory, USER_AGENT, archive, restore
from inventory import Inventory
import process_batch


class CloudInventoryTests(unittest.TestCase):
    def test_requests_identify_photostory_client(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 204
        client = CloudInventory('https://example.test', 'test')
        with patch.object(client.opener, 'open', return_value=response) as opened:
            client._request('GET')
            self.assertEqual(opened.call_args.args[0].get_header('User-agent'), USER_AGENT)

    def test_processor_uploads_before_acknowledging_checkpoint(self):
        events = []
        cloud = MagicMock()
        cloud.require_seed.side_effect = lambda: events.append('seed')
        cloud.load.side_effect = lambda *args: events.append('load')
        cloud.save.side_effect = lambda *args: (events.append('save') or 'snapshot-ref')
        inventory = MagicMock()
        inventory.scan.return_value = False
        inventory.progress.return_value = {'phase': 'scanning', 'total': 1,
                                           'processed': 0, 'analyzed': 0, 'batches': 0}

        def request(url, **kwargs):
            route = url.rsplit('/', 1)[-1]
            if route == 'claim':
                result = {'id': 'job', 'lease': 'lease'}
            elif route == 'source':
                result = {'pipeline': 2, 'folder': 'Photos', 'maxPhotos': 20,
                          'progress': {'phase': 'scanning'}, 'accessToken': 'token'}
            else:
                if route == 'checkpoint':
                    self.assertEqual(kwargs['body']['inventoryRef'], 'snapshot-ref')
                    events.append('checkpoint')
                result = {}
            return json.dumps(result).encode()

        with tempfile.TemporaryDirectory() as state, patch.dict(os.environ, {
            'PHOTOSTORY_URL': 'https://example.test', 'PHOTOSTORY_BATCH_TOKEN': 'test',
            'CODEX_GATEWAY_COMMAND': '/unused', 'PHOTOSTORY_STATE_DIR': state,
            'PHOTOSTORY_STATE_BACKEND': 'cloudflare'}, clear=True), \
                patch('cloud_inventory.CloudInventory', return_value=cloud), \
                patch('inventory.Inventory', return_value=inventory), \
                patch.object(process_batch, 'request', side_effect=request):
            process_batch.run()
        self.assertEqual(events, ['seed', 'load', 'save', 'checkpoint'])

    def test_preacknowledgment_snapshot_contains_reconciled_batch(self):
        source = {'folder': 'Photos', 'start': '2026-01-01', 'end': '2026-01-02'}
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / 'state'
            current = Inventory(state, 'job', source, 'policy')
            with current.db:
                current.db.execute("INSERT INTO photos(id,body,taken,fingerprint,status) VALUES('p','{}',1,'fingerprint','pending')")
            batch = current.stage_batch([{'id': 'p', 'fingerprint': 'fingerprint'}])
            current.save_screening({'p': 'digest'}, {}, {'p': 'grouped'})
            data = archive(state, 'job', source, 'policy', batch)
            self.assertIsNotNone(current.get('inflight'))
            restored = Path(root) / 'restored'
            restore(restored, data)
            copy = Inventory(restored, 'job', source, 'policy')
            self.assertIsNone(copy.get('inflight'))
            self.assertEqual(copy.progress()['processed'], 1)
            copy.close()
            current.close()

    def test_archive_rejects_path_traversal_without_writing(self):
        with tempfile.TemporaryDirectory() as root:
            data = io.BytesIO()
            with zipfile.ZipFile(data, 'w') as bundle:
                bundle.writestr('../outside.sqlite3', b'not a database')
            target = Path(root) / 'state'
            with self.assertRaisesRegex(ValueError, 'invalid_inventory_archive'):
                restore(target, data.getvalue())
            self.assertEqual(list(target.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
