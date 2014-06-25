var pagesSchema = {
	properties: {
		route:{
			type: 'string',
			required: true
		},
		title:{
			type: 'string',
			required: true
		},
		parent:{
			type: 'any',
			info:{
				type:'select',
				schema: 'pages'
			}
		},
		content:{
			type: 'string',
			required: true,
			info:{
				type:'textarea'
			}
		}
	}
};
try{
	module.exports = pagesSchema;
}catch(e){}