/**
 * TypeScript to JavaScript transpiler for QuickJS
 * Removes type annotations, generics, async/await, imports, decorators
 * 
 * Usage: transpile(sourceCode)
 * Returns: JavaScript code compatible with QuickJS
 */

function transpile(code) {
    const lines = code.split('\n');
    const result = [];
    
    for (let line of lines) {
        line = transposeLine(line);
        if (line !== null) {
            result.push(line);
        }
    }
    
    return result.join('\n');
}

function transposeLine(line) {
    let originalLine = line;
    
    // Remove import statements completely
    if (/^\s*import\s+/.test(line)) {
        return '';
    }
    
    // Remove export keyword, keep the declaration
    line = line.replace(/^\s*export\s+(async\s+)?(function|const|let|var|class)\b/, '$2');
    
    // Remove decorators @decorator
    line = line.replace(/^\s*@\w+.*$/, '');
    
    // Remove type annotations in function parameters/declarations
    line = removeTypeAnnotations(line);
    
    // Remove generic types <T, U, ...>
    line = line.replace(/<[^>]+>/g, '');
    
    // Remove async keyword from function declarations
    line = line.replace(/\basync\s+function\b/g, 'function');
    line = line.replace(/\basync\s*\(/g, '(');
    line = line.replace(/\basync\s*=>\s*/g, '=> ');
    
    // Remove await keyword
    line = line.replace(/\bawait\s+/g, '');
    
    // Only return non-empty lines or lines that are just whitespace after removal
    if (line.trim() === '') {
        return '';
    }
    
    return line;
}

function removeTypeAnnotations(line) {
    let result = '';
    let i = 0;
    let inString = false;
    let stringChar = null;
    let depth = 0;  // parenthesis depth
    
    while (i < line.length) {
        const ch = line[i];
        const prevCh = i > 0 ? line[i - 1] : '';
        
        // Handle strings
        if ((ch === '"' || ch === "'" || ch === '`') && prevCh !== '\\') {
            if (!inString) {
                inString = true;
                stringChar = ch;
                result += ch;
            } else if (ch === stringChar) {
                inString = false;
                stringChar = null;
                result += ch;
            } else {
                result += ch;
            }
            i++;
            continue;
        }
        
        // Don't process inside strings
        if (inString) {
            result += ch;
            i++;
            continue;
        }
        
        // Track parenthesis depth
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        
        // When we see : inside parentheses (function parameters)
        if (depth > 0 && ch === ':' && prevCh !== ':' && prevCh !== '=') {
            // Check if the character before is alphanumeric or _ or )
            const trimmedBefore = result.trimEnd();
            if (trimmedBefore.length > 0 && /[a-zA-Z0-9_\])]$/.test(trimmedBefore)) {
                // This looks like a type annotation, skip it
                i++; // skip the ':'
                
                // Skip whitespace
                while (i < line.length && line[i] === ' ') i++;
                
                // Skip the type (might include spaces, [], |, &, etc)
                let typeDepth = 0;
                while (i < line.length) {
                    const ch = line[i];
                    if (ch === '[') typeDepth++;
                    else if (ch === ']') typeDepth--;
                    else if (typeDepth === 0 && (ch === ',' || ch === ')' || ch === '=')) break;
                    i++;
                }
                continue;
            }
        }
        
        result += ch;
        i++;
    }
    
    return result;
}

// Transpiler is now available globally in QuickJS context

