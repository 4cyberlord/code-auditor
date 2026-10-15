/**
 * GitHub-style unified line diff for provisional -> Council-final source.
 * Pure/local: no external API, no extra model tokens, no persisted duplicate.
 */
export type ChangeKind="context"|"removed"|"added";
export interface DiffLine {
  kind:ChangeKind;
  text:string;
  beforeLine:number|null;
  afterLine:number|null;
}
export function codeLineDiff(before:string,after:string):DiffLine[]{
  const oldLines=String(before||"").replace(/\r\n/g,"\n").split("\n");
  const newLines=String(after||"").replace(/\r\n/g,"\n").split("\n");
  let prefix=0;
  while(prefix<oldLines.length&&prefix<newLines.length&&
    oldLines[prefix]===newLines[prefix])prefix++;
  let suffix=0;
  while(suffix<oldLines.length-prefix&&suffix<newLines.length-prefix&&
    oldLines[oldLines.length-1-suffix]===newLines[newLines.length-1-suffix])suffix++;
  const result:DiffLine[]=[];
  for(let i=0;i<prefix;i++)
    result.push({kind:"context",text:oldLines[i],beforeLine:i+1,afterLine:i+1});
  const a=oldLines.slice(prefix,oldLines.length-suffix);
  const b=newLines.slice(prefix,newLines.length-suffix);
  const m=a.length,n=b.length;
  if((m+1)*(n+1)<=1_500_000){
    const cells=new Uint32Array((m+1)*(n+1));
    const width=n+1;
    for(let i=m-1;i>=0;i--)for(let j=n-1;j>=0;j--){
      const p=i*width+j;
      cells[p]=a[i]===b[j]?1+cells[(i+1)*width+j+1]:
        Math.max(cells[(i+1)*width+j],cells[p+1]);
    }
    let i=0,j=0;
    while(i<m||j<n){
      if(i<m&&j<n&&a[i]===b[j]){
        result.push({kind:"context",text:a[i],beforeLine:prefix+i+1,afterLine:prefix+j+1});
        i++;j++;
      }else if(j<n&&(i===m||cells[i*width+j+1]>cells[(i+1)*width+j])){
        result.push({kind:"added",text:b[j],beforeLine:null,afterLine:prefix+j+1});
        j++;
      }else{
        result.push({kind:"removed",text:a[i],beforeLine:prefix+i+1,afterLine:null});
        i++;
      }
    }
  }else{
    // For very large, entirely different files, avoid quadratic memory.
    // Preserve exact source lines and numbering even without fine alignment.
    for(let i=0;i<m;i++)
      result.push({kind:"removed",text:a[i],beforeLine:prefix+i+1,afterLine:null});
    for(let j=0;j<n;j++)
      result.push({kind:"added",text:b[j],beforeLine:null,afterLine:prefix+j+1});
  }
  for(let i=0;i<suffix;i++){
    const oldIndex=oldLines.length-suffix+i,newIndex=newLines.length-suffix+i;
    result.push({kind:"context",text:oldLines[oldIndex],beforeLine:oldIndex+1,afterLine:newIndex+1});
  }
  return result;
}
