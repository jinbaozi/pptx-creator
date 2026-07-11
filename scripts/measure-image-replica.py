#!/usr/bin/env python3
"""Authoritative image-replica visual/OCR/geometry measurements."""
import argparse, json, math, sys
from collections import Counter
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(ROOT/"scripts/lib"))
from replica_metrics_core import compare_replica_images
from ocr_core import ocr_image

def cer(a,b):
    a=" ".join(a.upper().split()); b=" ".join(b.upper().split()); prev=list(range(len(b)+1))
    for i,ca in enumerate(a,1):
        row=[i]
        for j,cb in enumerate(b,1): row.append(min(row[-1]+1,prev[j]+1,prev[j-1]+(ca!=cb)))
        prev=row
    return prev[-1]/max(1,len(a))
def iou(a,b):
    # OCR engines quantize glyph bounds differently at antialiased edges. Give
    # both observations a symmetric one-pixel localization tolerance; larger
    # shifts and size errors still reduce the intersection normally.
    a={'x':a['x']-1,'y':a['y']-1,'w':a['w']+2,'h':a['h']+2}
    b={'x':b['x']-1,'y':b['y']-1,'w':b['w']+2,'h':b['h']+2}
    x1=max(a['x'],b['x']);y1=max(a['y'],b['y']);x2=min(a['x']+a['w'],b['x']+b['w']);y2=min(a['y']+a['h'],b['y']+b['h']); inter=max(0,x2-x1)*max(0,y2-y1)
    return inter/max(1,a['w']*a['h']+b['w']*b['h']-inter)
def text_key(value): return ''.join(character for character in value.upper() if character.isalnum())
def text_lines(blocks):
    lines=[]
    for word in sorted(blocks,key=lambda item:(item['pixelBox']['y']+item['pixelBox']['h']/2,item['pixelBox']['x'])):
        box=word['pixelBox']; center=box['y']+box['h']/2
        def belongs(line):
            avg=sum(item['pixelBox']['y']+item['pixelBox']['h']/2 for item in line)/len(line)
            return abs(center-avg)<=max(box['h'],max(item['pixelBox']['h'] for item in line))*.65
        match=next((line for line in lines if belongs(line)),None)
        (lines.append([word]) if match is None else match.append(word))
    split=[]
    for line in lines:
        current=[]
        for word in sorted(line,key=lambda item:item['pixelBox']['x']):
            if current:
                previous=current[-1]['pixelBox']; gap=word['pixelBox']['x']-(previous['x']+previous['w'])
                if gap>max(80,word['pixelBox']['h']*5): split.append(current);current=[]
            current.append(word)
        if current: split.append(current)
    lines=split
    merged=[]
    for line in lines:
        line=sorted(line,key=lambda item:item['pixelBox']['x']); boxes=[item['pixelBox'] for item in line]
        x=min(b['x'] for b in boxes);y=min(b['y'] for b in boxes);right=max(b['x']+b['w'] for b in boxes);bottom=max(b['y']+b['h'] for b in boxes)
        merged.append({'text':' '.join(item['text'] for item in line),'pixelBox':{'x':x,'y':y,'w':right-x,'h':bottom-y}})
    return merged
def palette(path,n=12,exclude=()):
    with Image.open(path) as im:
        rgb=im.convert('RGB'); samples=[]
        for y in range(0,rgb.height,4):
            for x in range(0,rgb.width,4):
                if any(box['x']<=x<box['x']+box['w'] and box['y']<=y<box['y']+box['h'] for box in exclude): continue
                samples.append(rgb.getpixel((x,y)))
        minimum=max(2,math.ceil(len(samples)*.001))
        return [color for color,count in Counter(samples).most_common() if count>=minimum][:n]
def lab(rgb):
    v=[]
    for c in rgb:
        c=c/255; v.append(c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4)
    x,y,z=(v[0]*.4124+v[1]*.3576+v[2]*.1805)/.95047,(v[0]*.2126+v[1]*.7152+v[2]*.0722),(v[0]*.0193+v[1]*.1192+v[2]*.9505)/1.08883
    f=lambda t:t**(1/3) if t>.008856 else 7.787*t+16/116
    return (116*f(y)-16,500*(f(x)-f(y)),200*(f(y)-f(z)))
def delta(a,b):
    # CIEDE2000, kL=kC=kH=1.
    l1,a1,b1=lab(a); l2,a2,b2=lab(b); c1=math.hypot(a1,b1); c2=math.hypot(a2,b2); cm=(c1+c2)/2
    g=.5*(1-math.sqrt(cm**7/(cm**7+25**7)))
    ap1=(1+g)*a1; ap2=(1+g)*a2; cp1=math.hypot(ap1,b1); cp2=math.hypot(ap2,b2)
    hp1=(math.degrees(math.atan2(b1,ap1))+360)%360 if cp1 else 0; hp2=(math.degrees(math.atan2(b2,ap2))+360)%360 if cp2 else 0
    dl=l2-l1; dc=cp2-cp1; dh=hp2-hp1
    if cp1*cp2==0: dh=0
    elif dh>180: dh-=360
    elif dh<-180: dh+=360
    d_h=2*math.sqrt(cp1*cp2)*math.sin(math.radians(dh/2)); lm=(l1+l2)/2; cpm=(cp1+cp2)/2
    if cp1*cp2==0: hm=hp1+hp2
    elif abs(hp1-hp2)<=180: hm=(hp1+hp2)/2
    elif hp1+hp2<360: hm=(hp1+hp2+360)/2
    else: hm=(hp1+hp2-360)/2
    t=1-.17*math.cos(math.radians(hm-30))+.24*math.cos(math.radians(2*hm))+.32*math.cos(math.radians(3*hm+6))-.20*math.cos(math.radians(4*hm-63))
    sl=1+.015*(lm-50)**2/math.sqrt(20+(lm-50)**2); sc=1+.045*cpm; sh=1+.015*cpm*t
    rt=-2*math.sqrt(cpm**7/(cpm**7+25**7))*math.sin(math.radians(60*math.exp(-((hm-275)/25)**2)))
    return math.sqrt((dl/sl)**2+(dc/sc)**2+(d_h/sh)**2+rt*(dc/sc)*(d_h/sh))
def main():
    ap=argparse.ArgumentParser();ap.add_argument('source',type=Path);ap.add_argument('render',type=Path);ap.add_argument('plan',type=Path);args=ap.parse_args()
    pixel=compare_replica_images(args.source,args.render); src=ocr_image(args.source,langs='eng',min_confidence=0); rnd=ocr_image(args.render,langs='eng',min_confidence=0); plan=json.loads(args.plan.read_text())
    ocr_ok=src.get('status')=='ok' and rnd.get('status')=='ok'
    st=' '.join(x['text'] for x in src.get('textBlocks',[])); rt=' '.join(x['text'] for x in rnd.get('textBlocks',[]))
    rendered_lines=text_lines(rnd.get('textBlocks',[])); expected_objects=[x for x in plan['objects'] if x['kind']=='editable-text' and x.get('confidence',0)>=plan['threshold']]
    unused=set(range(len(rendered_lines))); ious=[]
    for item in expected_objects:
        candidates=[index for index in unused if text_key(rendered_lines[index]['text'])==text_key(item['text'])]
        if not candidates: ious.append(0); continue
        selected=max(candidates,key=lambda index:iou(item['pixelBox'],rendered_lines[index]['pixelBox']))
        ious.append(iou(item['pixelBox'],rendered_lines[selected]['pixelBox']));unused.remove(selected)
    excluded=[x['pixelBox'] for x in plan['objects'] if x['kind']=='cropped-asset']; sp=palette(args.source,exclude=excluded);rp=palette(args.render,exclude=excluded); ds=sorted(min(delta(c,r) for r in rp) for c in sp)
    expected=[text_key(token) for x in expected_objects for token in x['text'].split()]; found=[text_key(x['text']) for x in rnd.get('textBlocks',[])]; remaining=list(found); recalled=0
    for token in expected:
        if token in remaining: recalled+=1;remaining.remove(token)
    out={**pixel,'ocrStatus':'ok' if ocr_ok else 'unavailable','ocrCer':round(cer(st,rt),6) if ocr_ok else None,'bboxIou':round(sum(ious)/len(ious),6) if ocr_ok and ious else None,'paletteDeltaE2000P95':round(ds[max(0,math.ceil(len(ds)*.95)-1)],6) if ds else None,'nativeHighConfidenceTextRecall':round(recalled/max(1,len(expected)),6) if ocr_ok else None,'sourceText':st,'renderText':rt}
    print(json.dumps(out))
if __name__=='__main__':main()
