import math
B={'北':0,'東北':45,'東':90,'東南':135,'南':180,'西南':225,'西':270,'西北':315}
P={'F01':('東北',48),'F02':('西南',38),'F03':('東',64),'F04':('北',92),'F05':('東南',73),'F06':('東南',23),'F07':('東',31),'F08':('西北',83),'F09':('東南',19),'F10':('南',42),'F11':('南',35)}
xy={k:(math.sin(math.radians(B[b]))*d, math.cos(math.radians(B[b]))*d) for k,(b,d) in P.items()}
for k,v in xy.items(): print(k, round(v[0],2), round(v[1],2))
def rng(a,b):
    (ba,da),(bb,db)=P[a],P[b]
    lo=1e9;hi=0
    for ta in [B[ba]+x for x in range(-22,23)]:
        for tb in [B[bb]+x for x in range(-22,23)]:
            th=math.radians(ta-tb)
            L=math.sqrt(da*da+db*db-2*da*db*math.cos(th))
            lo=min(lo,L);hi=max(hi,L)
    nom=math.dist(xy[a],xy[b])
    return round(nom,1),round(lo,1),round(hi,1)
for a,b in [('F01','F04'),('F04','F05'),('F08','F05')]:
    print(a,b,'schematic,min,max (bearing ±22.5°, distance exact):',rng(a,b),'abs triangle min',abs(P[a][1]-P[b][1]))
