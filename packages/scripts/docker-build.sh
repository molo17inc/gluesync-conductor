cd $1

NAME="${CI_REGISTRY_IMAGE}/$2"

echo "Building $NAME"

docker build -t $NAME .

docker push $NAME
