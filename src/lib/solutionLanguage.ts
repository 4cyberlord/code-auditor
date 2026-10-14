/** Display language follows the returned solution, never an idle TEXT placeholder. */
export interface CodeLanguage { id:string; label:string; extension:string }
const languages:Record<string,CodeLanguage>={
 python:{id:"python",label:"Python",extension:".py"},
 javascript:{id:"javascript",label:"JavaScript",extension:".js"},
 typescript:{id:"typescript",label:"TypeScript",extension:".ts"},
 java:{id:"java",label:"Java",extension:".java"},
 cpp:{id:"cpp",label:"C++",extension:".cpp"},
 c:{id:"c",label:"C",extension:".c"},
 rust:{id:"rust",label:"Rust",extension:".rs"},
 go:{id:"go",label:"Go",extension:".go"},
 swift:{id:"swift",label:"Swift",extension:".swift"},
 kotlin:{id:"kotlin",label:"Kotlin",extension:".kt"},
 csharp:{id:"csharp",label:"C#",extension:".cs"},
 ruby:{id:"ruby",label:"Ruby",extension:".rb"},
 php:{id:"php",label:"PHP",extension:".php"},
 bash:{id:"bash",label:"Shell",extension:".sh"},
 sql:{id:"sql",label:"SQL",extension:".sql"},
};
const aliases:Record<string,string>={py:"python",python3:"python",js:"javascript",node:"javascript",nodejs:"javascript",jsx:"javascript",ts:"typescript",tsx:"typescript",golang:"go","c++":"cpp",cxx:"cpp",cc:"cpp",rs:"rust","c#":"csharp",cs:"csharp",dotnet:"csharp",sh:"bash",shell:"bash",zsh:"bash",rb:"ruby",kt:"kotlin"};
const byName=(name:string):CodeLanguage|null=>{
 const key=name.trim().toLowerCase().replace(/^\./,"").replace(/^language:\s*/,"");
 return languages[aliases[key]??key]??null;
};
export function inferCodeLanguage(code:string):CodeLanguage|null{
 const s=code.slice(0,16000);
 if(!s.trim())return null;
 if(/<\?php\b/.test(s))return languages.php;
 if(/^\s*#!.*\b(?:bash|zsh|sh)\b/m.test(s))return languages.bash;
 if(/^\s*(?:from\s+[\w.]+\s+import|import\s+[\w.]+|(?:async\s+)?def\s+\w+\s*\(|class\s+\w+(?:\([^\n]*\))?\s*:)/m.test(s))return languages.python;
 if(/^\s*(?:use\s+(?:std|crate|super)::|(?:pub\s+)?(?:async\s+)?fn\s+\w+\s*\(|impl\s+\w+|let\s+mut\s+)/m.test(s))return languages.rust;
 if(/^\s*(?:package\s+\w+|func\s+(?:\([^)]*\)\s*)?\w+\s*\()/m.test(s))return languages.go;
 if(/^\s*#include\s*[<"]|\bstd::\w+|\bvector<|\bunordered_map</m.test(s))return languages.cpp;
 if(/\busing\s+System\s*;|\bnamespace\s+\w+[\s\S]{0,250}\bclass\s+\w+/m.test(s))return languages.csharp;
 if(/\b(?:import\s+java\.|System\.out\.|public\s+static\s+void\s+main\s*\()/m.test(s))return languages.java;
 if(/^\s*(?:import\s+Foundation|func\s+\w+\s*\(|struct\s+\w+\s*:\s*\w+)/m.test(s))return languages.swift;
 if(/^\s*(?:fun\s+\w+\s*\(|package\s+[\w.]+\s*$)|\bval\s+\w+\s*=/m.test(s))return languages.kotlin;
 if(/\b(?:interface|type)\s+\w+\s*(?:\{|=)|\b(?:const|let)\s+\w+\s*:\s*(?:string|number|boolean|\w+\[\])/m.test(s))return languages.typescript;
 if(/\b(?:function\s+\w+\s*\(|(?:const|let)\s+\w+\s*=|module\.exports\s*=|console\.log\s*\()/m.test(s))return languages.javascript;
 if(/^\s*(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|CREATE\s+TABLE)\b/im.test(s))return languages.sql;
 if(/\bprintf\s*\(|\bscanf\s*\(/m.test(s))return languages.c;
 return null;
}
export function describeCodeLanguage(code:string,declared?:string|null):CodeLanguage{
 if(!code.trim())return {id:"",label:"Awaiting solution",extension:""};
 return byName(declared??"")??inferCodeLanguage(code)??{id:"",label:"Code",extension:""};
}
