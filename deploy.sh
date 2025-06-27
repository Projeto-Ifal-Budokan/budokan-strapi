#!/bin/bash

# Strapi Production Deployment Script
set -e

echo "🚀 Starting Strapi Production Deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${RED}❌ .env file not found!${NC}"
    echo -e "${YELLOW}Please copy .env.example to .env and configure your environment variables.${NC}"
    exit 1
fi

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Docker is not running!${NC}"
    exit 1
fi

# Check if Docker Compose is available
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null 2>&1; then
    echo -e "${RED}❌ Docker Compose is not available!${NC}"
    exit 1
fi

# Function to generate secrets
generate_secrets() {
    echo -e "${YELLOW}🔐 Generating secrets...${NC}"
    
    JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
    ADMIN_JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
    API_TOKEN_SALT=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    TRANSFER_TOKEN_SALT=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    
    APP_KEY1=$(node -e "console.log(require('crypto').randomBytes(16).toString('base64'))")
    APP_KEY2=$(node -e "console.log(require('crypto').randomBytes(16).toString('base64'))")
    APP_KEY3=$(node -e "console.log(require('crypto').randomBytes(16).toString('base64'))")
    APP_KEY4=$(node -e "console.log(require('crypto').randomBytes(16).toString('base64'))")
    
    echo "Generated secrets:"
    echo "JWT_SECRET=${JWT_SECRET}"
    echo "ADMIN_JWT_SECRET=${ADMIN_JWT_SECRET}"
    echo "API_TOKEN_SALT=${API_TOKEN_SALT}"
    echo "TRANSFER_TOKEN_SALT=${TRANSFER_TOKEN_SALT}"
    echo "APP_KEYS=${APP_KEY1},${APP_KEY2},${APP_KEY3},${APP_KEY4}"
}

# Function to check environment variables
check_env_vars() {
    echo -e "${YELLOW}🔍 Checking environment variables...${NC}"
    
    required_vars=(
        "DATABASE_NAME"
        "DATABASE_USERNAME" 
        "DATABASE_PASSWORD"
        "MYSQL_ROOT_PASSWORD"
        "JWT_SECRET"
        "ADMIN_JWT_SECRET"
        "APP_KEYS"
        "API_TOKEN_SALT"
        "TRANSFER_TOKEN_SALT"
    )
    
    missing_vars=()
    
    for var in "${required_vars[@]}"; do
        if [ -z "${!var}" ]; then
            missing_vars+=("$var")
        fi
    done
    
    if [ ${#missing_vars[@]} -ne 0 ]; then
        echo -e "${RED}❌ Missing required environment variables:${NC}"
        printf '%s\n' "${missing_vars[@]}"
        echo -e "${YELLOW}Run with --generate-secrets to generate missing secrets${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✅ All required environment variables are set${NC}"
}

# Function to backup database
backup_database() {
    echo -e "${YELLOW}💾 Creating database backup...${NC}"
    
    BACKUP_DIR="./backups"
    mkdir -p $BACKUP_DIR
    
    BACKUP_FILE="$BACKUP_DIR/strapi_backup_$(date +%Y%m%d_%H%M%S).sql"
    
    if docker-compose ps strapi-mysql | grep -q "Up"; then
        docker-compose exec -T strapi-mysql mysqldump \
            -u root \
            -p"${MYSQL_ROOT_PASSWORD}" \
            "${DATABASE_NAME}" > "$BACKUP_FILE"
        echo -e "${GREEN}✅ Database backup created: $BACKUP_FILE${NC}"
    else
        echo -e "${YELLOW}⚠️  MySQL container not running, skipping backup${NC}"
    fi
}

# Function to build and deploy
deploy() {
    echo -e "${YELLOW}🏗️  Building and deploying services...${NC}"
    
    # Pull latest images
    docker-compose pull
    
    # Build the application
    docker-compose build --no-cache strapi
    
    # Start services
    docker-compose up -d
    
    # Wait for services to be healthy
    echo -e "${YELLOW}⏳ Waiting for services to be ready...${NC}"
    
    # Wait for MySQL
    echo "Waiting for MySQL..."
    until docker-compose exec strapi-mysql mysqladmin ping -h localhost -u root -p"${MYSQL_ROOT_PASSWORD}" --silent; do
        echo -n "."
        sleep 2
    done
    echo -e "${GREEN}✅ MySQL is ready${NC}"
    
    # Wait for Strapi
    echo "Waiting for Strapi..."
    until curl -f http://localhost:1337/_health > /dev/null 2>&1; do
        echo -n "."
        sleep 5
    done
    echo -e "${GREEN}✅ Strapi is ready${NC}"
}

# Function to show status
show_status() {
    echo -e "${YELLOW}📊 Service Status:${NC}"
    docker-compose ps
    
    echo -e "\n${YELLOW}📊 Container Health:${NC}"
    docker-compose exec strapi-mysql mysqladmin ping -h localhost -u root -p"${MYSQL_ROOT_PASSWORD}" --silent && echo -e "${GREEN}✅ MySQL: Healthy${NC}" || echo -e "${RED}❌ MySQL: Unhealthy${NC}"
    
    curl -f http://localhost:1337/_health > /dev/null 2>&1 && echo -e "${GREEN}✅ Strapi: Healthy${NC}" || echo -e "${RED}❌ Strapi: Unhealthy${NC}"
}

# Function to show logs
show_logs() {
    echo -e "${YELLOW}📋 Recent logs:${NC}"
    docker-compose logs --tail=50 strapi
}

# Parse command line arguments
case "${1:-deploy}" in
    "generate-secrets")
        generate_secrets
        ;;
    "check-env")
        source .env
        check_env_vars
        ;;
    "backup")
        source .env
        backup_database
        ;;
    "deploy")
        source .env
        check_env_vars
        backup_database
        deploy
        show_status
        echo -e "${GREEN}🎉 Deployment completed successfully!${NC}"
        echo -e "${YELLOW}📝 Access your Strapi admin through SWAG reverse proxy${NC}"
        echo -e "${YELLOW}📝 Make sure SWAG is configured to proxy to strapi-app:1337${NC}"
        ;;
    "status")
        show_status
        ;;
    "logs")
        show_logs
        ;;
    "stop")
        echo -e "${YELLOW}⏹️  Stopping services...${NC}"
        docker-compose down
        echo -e "${GREEN}✅ Services stopped${NC}"
        ;;
    "restart")
        echo -e "${YELLOW}🔄 Restarting services...${NC}"
        docker-compose restart
        show_status
        ;;
    "clean")
        echo -e "${YELLOW}🧹 Cleaning up...${NC}"
        docker-compose down -v --remove-orphans
        docker system prune -f
        echo -e "${GREEN}✅ Cleanup completed${NC}"
        ;;
    *)
        echo "Usage: $0 {generate-secrets|check-env|backup|deploy|status|logs|stop|restart|clean}"
        echo ""
        echo "Commands:"
        echo "  generate-secrets  Generate new secrets for environment variables"
        echo "  check-env        Check if all required environment variables are set"
        echo "  backup          Create a database backup"
        echo "  deploy          Deploy the application (default)"
        echo "  status          Show service status"
        echo "  logs            Show recent application logs"
        echo "  stop            Stop all services"
        echo "  restart         Restart all services"
        echo "  clean           Stop services and clean up containers/volumes"
        exit 1
        ;;
esac