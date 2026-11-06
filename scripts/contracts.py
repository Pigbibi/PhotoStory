"""Read the vocabulary shared with the worker.

The worker cannot import Python and the processor cannot import JavaScript, so
one JSON file holds every value both sides must agree on. Nothing here may
restate a value: a second copy is what made a processor timeout report as
`unknown` on the server.
"""
import json
import re
from pathlib import Path

VOCABULARY = json.loads((Path(__file__).resolve().parents[1] / 'contracts' / 'vocabulary.json').read_text('utf-8'))

FAILURE_CODES = frozenset(VOCABULARY['failureCodes'])
FAILURE_STAGES = frozenset(VOCABULARY['failureStages'])
FEEDBACK_CATEGORIES = tuple(VOCABULARY['feedbackCategories'])
PROMPT_LANGUAGES = dict(VOCABULARY['promptLanguages'])
ASPECTS = tuple(VOCABULARY['aspects'])
ASPECT_BY_ORIENTATION = dict(VOCABULARY['aspectByOrientation'])
MATCH_ALGORITHM = VOCABULARY['matchAlgorithm']
DRAFT_TEXT_LIMITS = dict(VOCABULARY['draftTextLimits'])
DRAFT_PHOTO_LIMIT = VOCABULARY['draftPhotoLimit']
INSTAGRAM_ID = re.compile(VOCABULARY['instagramIdPattern'])
