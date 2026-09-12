"""One bounded automatic publication step. Manual is the server-side default."""
import base64
import hashlib
import io
import json
import tempfile
from pathlib import Path
from PIL import Image, ImageOps, ImageCms
from auto_review import PROMPT, SCHEMA, FIELDS


def render(raw, aspect, frame):
    """Match browser cover positioning, orient pixels, strip EXIF, never upscale."""
    if frame['mode'] != 'crop':
        raise ValueError('crop_required')
    ratio = {'4:5': 4/5, '3:2': 3/2, '1:1': 1}[aspect]
    size = (1080, round(1080/ratio))
    with Image.open(io.BytesIO(raw)) as source:
        if source.format not in ('JPEG', 'PNG') or source.width*source.height > 50_000_000:
            raise ValueError('original_format')
        image = ImageOps.exif_transpose(source)
        if max(size[0]/image.width, size[1]/image.height) > 1:
            raise ValueError('original_too_small')
        if image.info.get('icc_profile'):
            image = ImageCms.profileToProfile(image, ImageCms.ImageCmsProfile(io.BytesIO(image.info['icc_profile'])), ImageCms.createProfile('sRGB'), outputMode='RGB')
        else:
            image = image.convert('RGB')
        canvas = ImageOps.fit(image, size, method=Image.Resampling.LANCZOS,
                              centering=(frame['x']/100, frame['y']/100))
        # A fresh canvas ensures inherited EXIF/XMP/ICC aren't emitted by Pillow.
        clean = Image.new('RGB', size)
        clean.paste(canvas)
        out = io.BytesIO()
        clean.save(out, 'JPEG', quality=95)
        if out.tell() > 1_800_000:
            raise ValueError('image_too_large')
        return out.getvalue()


def tick(call, download, gateway):
    candidate = call('/internal/autopublish', {'action': 'candidate'})
    if not candidate:
        return
    draft, publication = candidate['draft'], candidate['publication']
    auth = {'draftId': draft['id'], 'version': draft['version'], 'publicationId': publication['id']}
    def action(name, **body):
        return call('/internal/autopublish', {**auth, 'action': name, **body})
    if publication['status'] == 'publishing':
        action('advance')  # One durable Meta operation per timer tick.
        return True
    if publication['status'] != 'prepared':
        return
    # No automatic replay of a crashed/failed preparation or ambiguous begin.
    beginning = False
    try:
        with tempfile.TemporaryDirectory(prefix='photostory-publish-') as tmp:
            cwd, paths, evidence = Path(tmp), [], []
            orientations = set()
            for i, photo in enumerate(draft['photos']):
                raw = download('/internal/autopublish', {**auth, 'action': 'original', 'photoId': photo['id']})
                with Image.open(io.BytesIO(raw)) as source:
                    image = ImageOps.exif_transpose(source)
                    orientations.add('landscape' if image.width > image.height else 'portrait' if image.width < image.height else 'square')
                data = render(raw, draft['aspect'], photo['frame'])
                path = cwd / (str(i)+'.jpg')
                path.write_bytes(data)
                paths.append(path)
                evidence.append({'id': photo['id'], 'digest': hashlib.sha256(data).hexdigest()})
                action('upload', photoId=photo['id'], data=base64.b64encode(data).decode())
            if len(orientations) != 1:
                raise ValueError('mixed_orientation')
            review = gateway(PROMPT+'\nFinal original-resolution post (data):\n'+json.dumps(draft, ensure_ascii=False),
                             [{'id': p['id']} for p in draft['photos']], paths, SCHEMA, cwd)
            if not isinstance(review, dict) or set(review) != set(FIELDS) or any(type(review[k]) is not bool for k in FIELDS) or review['needsHumanReview'] or not all(review[k] for k in FIELDS if k != 'needsHumanReview'):
                action('reject')
                return
            beginning = True
            action('begin', review=review, images=evidence)
            return True
    except Exception:
        if not beginning:
            try:
                action('reject')
            except Exception:
                pass
        # Raw network/provider exceptions may contain signed URLs or credentials.
        print('Automatic preparation stopped; inspect the private draft.')
