/** Canonical address shared by flat PM fields and structured accounting/vendor APIs. */
export function formatVendorAddress(a:{street?:string;unit?:string;city?:string;state?:string;zip?:string;country?:string}) {
 return [a.street,a.unit,a.city,[a.state,a.zip].filter(Boolean).join(' '),a.country].map(x=>String(x??'').trim()).filter(Boolean).join(', ');
}
export function parseVendorAddress(value:string) {
 const parts=value.split(',').map(x=>x.trim()).filter(Boolean);
 let country='';if(parts.length && /^(US|USA|United States|Canada|CA)$/i.test(parts[parts.length-1]!))country=parts.pop()!;
 const stateZip=parts.pop()?.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d)$/i);
 if(!stateZip || parts.length<2)return null;
 const city=parts.pop()!,street=parts.shift()!,unit=parts.join(', ');
 return {street,unit,city,state:stateZip[1]!.toUpperCase(),zip:stateZip[2]!,country};
}
