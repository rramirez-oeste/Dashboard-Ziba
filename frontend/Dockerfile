# Usamos Nginx para servir los archivos estáticos HTML/CSS/JS
FROM nginx:alpine

# Copiamos todo el contenido de la carpeta frontend a la carpeta pública de Nginx
COPY . /usr/share/nginx/html

# Exponemos el puerto estándar web HTTP
EXPOSE 80

# Nginx se inicia automáticamente, no necesitamos un comando CMD explícito