"""Conservative, local burst screening. No AI, originals or image cache writes."""
import hashlib
import io
from PIL import Image,ImageFilter,ImageStat


def bits(values):
    return format(sum(int(value)<<i for i,value in enumerate(values)),'x')


def profile(photo,data):
    with Image.open(io.BytesIO(data)) as image:
        image=image.convert('RGB')
        gray=image.convert('L')
        small=gray.resize((16,16),Image.Resampling.LANCZOS)
        pixels=list(small.tobytes());mean=sum(pixels)/len(pixels)
        edge=list(gray.resize((17,16),Image.Resampling.LANCZOS).tobytes())
        # Equal-size edge energy is only a clarity proxy, not an aesthetic verdict.
        focus=gray.resize((240,160),Image.Resampling.LANCZOS).filter(ImageFilter.FIND_EDGES).crop((2,2,238,158))
        return {'taken':photo['taken'],'aspect':image.width/image.height,
                'digest':hashlib.sha256(data).hexdigest(),
                'dhash':bits(edge[y*17+x]>edge[y*17+x+1] for y in range(16) for x in range(16)),
                'ahash':bits(v>mean for v in pixels),
                'color':ImageStat.Stat(image.resize((16,16))).mean,
                'contrast':ImageStat.Stat(small).stddev[0],
                'quality':ImageStat.Stat(focus).mean[0]}


def similar(a,b):
    if a['digest']==b['digest']:return True
    return (abs(a['taken']-b['taken'])<=120 and abs(a['aspect']-b['aspect'])<=0.02 and
            min(a['contrast'],b['contrast'])>=8 and
            (int(a['dhash'],16)^int(b['dhash'],16)).bit_count()<=16 and
            (int(a['ahash'],16)^int(b['ahash'],16)).bit_count()<=6 and
            max(abs(x-y) for x,y in zip(a['color'],b['color']))<=8)


def representatives(photos,previous=lambda photo:()):
    values=[(p,data,profile(p,data)) for p,data in photos]
    chosen=[]
    # Compare only with chosen representatives: no transitive similarity chains.
    for value in sorted(values,key=lambda v:(-v[2]['quality'],v[0]['taken'],v[0]['id'])):
        p,data,features=value
        if any(similar(features,old) and (features['digest']==old['digest'] or features['quality']<=old['quality']*1.2) for old in previous(p)):
            continue
        if any(similar(features,v[2]) for v in chosen):continue
        chosen.append(value)
    return sorted(chosen,key=lambda v:(v[0]['taken'],v[0]['id']))


def cover_first(photos,scores):
    """Highest score leads; equal scores preserve the model's crop-aware order."""
    if not photos:return []
    cover=max(photos,key=lambda p:scores[p['id']])
    return [cover]+[p for p in photos if p is not cover]
