import io
import unittest
from PIL import Image

from scripts.process_batch import dhash, hamming, valid_instagram_media_url


def image_bytes(color):
    out=io.BytesIO()
    Image.new('RGB',(32,24),color).save(out,format='JPEG')
    return out.getvalue()


class HistoryMatchTests(unittest.TestCase):
    def test_dhash_is_stable_for_resize_and_reencoding(self):
        raw=image_bytes((20,80,140))
        self.assertEqual(dhash(raw),dhash(raw))
        self.assertLessEqual(hamming(dhash(raw),dhash(raw)),8)

    def test_media_url_allowlist_rejects_redirect_and_userinfo(self):
        self.assertTrue(valid_instagram_media_url('https://scontent.cdninstagram.com/image.jpg'))
        self.assertTrue(valid_instagram_media_url('https://scontent.xx.fbcdn.net/image.jpg'))
        self.assertFalse(valid_instagram_media_url('http://scontent.cdninstagram.com/image.jpg'))
        self.assertFalse(valid_instagram_media_url('https://evil.example/image.jpg'))
        self.assertFalse(valid_instagram_media_url('https://user:pass@scontent.cdninstagram.com/image.jpg'))


if __name__ == '__main__':
    unittest.main()
