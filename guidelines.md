Every prompt must follow these rules:

1) Il testo della UI e in docs deve essere sempre in Inglese.
2) Ogni feature deve funzionare sia per desktop che mobile. E' probabile che da mobile occorre usare una libreria differente per fare la stessa cosa.
3) Se chiedo di cambiare una cosa, non renderla mai retrocompatibile (legacy support) se non te lo chiedo esplicitamente.
4) Quando si creano nuove classi/metodi da usare negli endpoint (script TypeScript) occorre documentare in docs e aggiungere supporto a MonacoEditor (hint)
5) 