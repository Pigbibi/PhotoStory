import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import process_batch as batch


def test_pilot_drafts_uses_place_and_description_instead_of_generic_scenic_copy():
    shortlist = [
        {
            'id': 'p1',
            'captured': '2026-10-01T17:30:00Z',
            'aesthetic': 9,
            'scene': 'architecture',
            'light': 'golden_hour',
            'description': 'Warm sunlight across the stone facade of the clock tower.',
            'place': {'city': 'Prague', 'landmark': 'Old Town Hall', 'evidence': 'tower sign', 'confidence': 'high'},
        },
        {
            'id': 'p2',
            'captured': '2026-10-02T09:15:00Z',
            'aesthetic': 8,
            'scene': 'street',
            'light': 'day',
            'description': 'Quiet cobblestone alley lined with pastel townhouses; morning shadows.',
            'place': {'city': '', 'landmark': '', 'evidence': '', 'confidence': 'none'},
        },
        {
            'id': 'p3',
            'captured': '2026-10-03T18:45:00Z',
            'aesthetic': 8,
            'scene': 'water',
            'light': 'blue_hour',
            'description': '',
            'place': {'city': '', 'landmark': '', 'evidence': '', 'confidence': 'none'},
        },
    ]
    dimensions = {'p1': (1600, 1200), 'p2': (1200, 1600), 'p3': (1200, 1200)}
    drafts = batch.pilot_drafts(
        shortlist,
        dimensions,
        limit=5,
        draft_prefix='job1-b1',
        source={'editorLanguage': 'en', 'captionLanguage': 'en'},
    )

    assert len(drafts) == 3
    by_photo = {d['photos'][0]['id']: d for d in drafts}

    assert by_photo['p1']['title'] == 'Old Town Hall, Prague'
    assert 'Warm sunlight across the stone facade' in by_photo['p1']['caption']
    assert 'Old Town Hall, Prague' in by_photo['p1']['caption']
    assert by_photo['p1']['hashtags'] == '#Architecture #UrbanPhotography #GoldenHour'
    assert by_photo['p1']['photos'][0]['alt'] == 'Warm sunlight across the stone facade of the clock tower.'
    assert by_photo['p1']['translations']['zh-CN']['title'] == 'Old Town Hall, Prague'

    assert by_photo['p2']['title'] == 'Quiet cobblestone alley lined with pastel townhouses'
    assert by_photo['p2']['caption'] == 'Quiet cobblestone alley lined with pastel townhouses; morning shadows.'
    assert by_photo['p2']['hashtags'] == '#StreetPhotography #Cityscape'
    assert by_photo['p2']['title'] != 'Scenic photo'

    assert by_photo['p3']['title'] == 'Blue Hour Waterfront'
    assert by_photo['p3']['caption'] == 'Blue Hour Waterfront.'
    assert by_photo['p3']['translations']['zh-CN']['title'] == '蓝调时刻水景'
    assert by_photo['p3']['hashtags'] == '#Waterfront #Landscape #BlueHour'


def test_pilot_drafts_respects_chinese_editor_and_caption_languages():
    shortlist = [
        {
            'id': 'p1',
            'captured': '2026-10-03T18:45:00Z',
            'aesthetic': 8,
            'scene': 'architecture',
            'light': 'night',
            'description': '',
            'place': {'city': '', 'landmark': '', 'evidence': '', 'confidence': 'none'},
        },
    ]
    drafts = batch.pilot_drafts(
        shortlist,
        {'p1': (1200, 1600)},
        limit=3,
        draft_prefix='job2-b1',
        source={'editorLanguage': 'zh-CN', 'captionLanguage': 'zh-CN'},
    )
    assert len(drafts) == 1
    assert drafts[0]['title'] == '夜景建筑'
    assert drafts[0]['caption'] == '夜景建筑，待编辑。'
    assert drafts[0]['translations']['en']['title'] == 'Night View Architecture'
    assert '#Architecture' in drafts[0]['hashtags']
    assert '#NightPhotography' in drafts[0]['hashtags']
